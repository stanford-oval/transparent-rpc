/* -*- mode: typescript; indent-tabs-mode: nil; -*- */
//
// Copyright 2015-2021 The Board of Trustees of the Leland Stanford Junior University
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
// IN THE SOFTWARE.
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>

import * as events from 'events';
import * as os from 'os';

export type ObjectId = string;

interface StubOrProxyLike {
    $free ?: () => void;
}

// this is a separate function to keep the environment clean
// and avoid spurious live objects
function make$free(obj : StubOrProxyLike, knownStubIds : Map<ObjectId, Stubbable>, id : ObjectId) {
    const prev$free = obj.$free;
    if (prev$free) {
        obj.$free = function() {
            knownStubIds.delete(id);
            return prev$free();
        };
    } else {
        obj.$free = function() {
            knownStubIds.delete(id);
        };
    }
}

let socketId = 0;

export class SocketClosedError extends Error {
    code : 'ERR_SOCKET_CLOSED';

    constructor() {
        super('Socket closed');
        this.code = 'ERR_SOCKET_CLOSED';
    }
}

export class InvalidObjectError extends Error {
    code : 'ENXIO';
    objectId : ObjectId;

    constructor(objId : ObjectId, msg : string) {
        super(msg);
        this.code = 'ENXIO'; // No such device or address
        this.objectId = objId;
    }
}

interface PromiseResolver {
    resolve(result : unknown) : void;
    reject(error : Error) : void;
}

interface StreamLike extends events.EventEmitter {
    write(obj : unknown, cb ?: (err ?: Error|null) => void) : void;
    end(cb ?: () => void) : void;
    destroy() : void;
}

export interface Stubbable<Methods extends string = string> {
    $rpcId ?: ObjectId;
    $rpcMethods : ReadonlyArray<Methods & keyof this>;
    $free ?: () => void;
}

interface CallMessage {
    control : 'call';
    id : number;
    obj : ObjectId;
    method : string;
    params : unknown[];
}

interface ReplyMessage {
    control : 'reply';
    id : number;
    error ?: string;
    message ?: string;
    stack ?: string;
    code ?: string|number;
    reply ?: unknown;
}

interface FreeMessage {
    control : 'free';
    id : ObjectId;
}

interface NewObjectMessage {
    control : 'new-object';
    obj : ObjectId;
    methods : readonly string[];
}

type AnyMessage = CallMessage | ReplyMessage | FreeMessage | NewObjectMessage;

class RpcSocket extends events.EventEmitter {
    private _socket : StreamLike;
    private _knownStubs : WeakMap<Stubbable, RpcStub>;
    private _knownStubIds : Map<ObjectId, Stubbable>;
    private _knownProxies : Map<ObjectId, RpcProxy>;
    private _pendingCalls : Map<number, PromiseResolver>;
    private _inCall : boolean;
    private _newObjects : NewObjectMessage[];
    private _callId : number;
    private _ended : boolean;
    private _stubCnt : number;
    private _socketId : string;

    constructor(socket : StreamLike) {
        super();
        this._socket = socket;
        this._knownStubs = new WeakMap;
        this._knownStubIds = new Map;
        this._knownProxies = new Map;
        this._pendingCalls = new Map;
        this._inCall = false;
        this._newObjects = [];
        this._callId = 0;
        this._ended = false;
        this._stubCnt = 0;
        this._socketId = `${os.hostname()}-${process.pid}:${socketId ++}:`;

        this._socket.on('data', this._handleMessage.bind(this));

        this._socket.on('error', (err) => {
            this._failAllCalls();
            this.emit('error', err);
        });
        this._socket.on('end', () => this.emit('end'));
        this._socket.on('close', (hadError : boolean) => {
            this._ended = true;
            this.emit('close', hadError);
        });
    }

    end(callback ?: () => void) : void {
        this._socket.end(callback);
    }

    destroy() : void {
        this._socket.destroy();
    }

    private _sendMetadata(stub : RpcStub) {
        if (this._inCall) {
            const msg : NewObjectMessage = {
                control:'new-object',
                obj: stub.$rpcId,
                methods: stub.methods
            };
            this._newObjects.push(msg);
        } else {
            const msg : NewObjectMessage = {
                control:'new-object',
                obj: stub.$rpcId,
                methods: stub.methods
            };
            this._socket.write(msg);
        }
    }

    addStub<T extends Stubbable>(obj : T) : ObjectId {
        if (this._knownStubs.has(obj)) {
            const stub = this._knownStubs.get(obj)!;

            // the proxy was freed and subsequently resurrected, send the metadata again
            if (!this._knownStubIds.has(stub.$rpcId)) {
                this._knownStubIds.set(stub.$rpcId, obj);
                this._sendMetadata(stub);
            }
            return stub.$rpcId;
        }

        if (!obj.$rpcMethods)
            throw new TypeError('Invalid stub object');

        const cnt = this._stubCnt ++;
        const rpcId = this._socketId + cnt;
        const stub = new RpcStub(obj, rpcId);

        make$free(obj, this._knownStubIds, rpcId);

        // NOTE: we store the object, not the stub in knownStubIds
        // this guarantees that knownStubIds has no references to
        // the socket, which means the object has no references to
        // the socket either
        // the object has a reference to knownStubIds through the
        // environment of $free
        // if the object is alive, we can get to the RpcStub
        // using knownStubs
        this._knownStubs.set(obj, stub);
        this._knownStubIds.set(rpcId, obj);
        this._sendMetadata(stub);
        return stub.$rpcId;
    }

    private _marshalArgument(arg : unknown) : unknown {
        if (typeof arg !== 'object' || arg === null)
            return arg;

        if (Array.isArray(arg)) {
            return arg.map(this._marshalArgument.bind(this));
        } else if ((arg as any).$rpcId !== undefined) {
            const rpcId : ObjectId = (arg as any).$rpcId;
            if (this._knownProxies.has(rpcId))
                return {$rpcId: rpcId};
            throw new InvalidObjectError(rpcId, 'Invalid object ' + rpcId.toString() + ', likely a proxy from a different socket');
        } else if ((arg as any).$rpcMethods) {
            return {$rpcId: this.addStub(arg as Stubbable)};
        } else {
            return arg;
        }
    }

    private _unmarshalArgument(arg : unknown) : unknown {
        if (typeof arg !== 'object' || arg === null)
            return arg;

        if (Array.isArray(arg)) {
            return arg.map(this._unmarshalArgument.bind(this));
        } else if ((arg as any).$rpcId !== undefined) {
            const rpcId : ObjectId = (arg as any).$rpcId;
            const stub = this._knownStubIds.get(rpcId);
            if (stub !== undefined)
                return stub;
            const proxy = this._knownProxies.get(rpcId);
            if (proxy !== undefined)
                return proxy;
            throw new TypeError('Invalid object ' + rpcId);
        } else {
            return arg;
        }
    }

    private _failAllCalls() {
        const err = new SocketClosedError();
        for (const call of this._pendingCalls.values())
            call.reject(err);
        this._pendingCalls = new Map;
    }

    call(obj : ObjectId, method : string, args : unknown[]) : Promise<unknown> {
        if (this._inCall)
            throw new TypeError('Re-entrant calls are not supported');
        if (this._ended)
            return Promise.reject(new SocketClosedError());

        this._inCall = true;
        const marshalled = args.map(this._marshalArgument.bind(this));
        this._newObjects.forEach((obj) => {
            this._socket.write(obj);
        });
        this._newObjects = [];
        this._inCall = false;

        const id = this._callId++;
        return new Promise((resolve, reject) => {
            this._pendingCalls.set(id, { resolve, reject });

            const msg : CallMessage = {
                control:'call', id: id,
                obj: obj, method: method,
                params: marshalled
            };
            this._socket.write(msg);
        });
    }

    freeProxy(id : ObjectId) : void {
        this._knownProxies.delete(id);
        if (this._ended)
            return;
        this._socket.write({control:'free', id: id}, (err) => {
            if (err)
                console.log(`Ignored error while freeing proxy: ${err.message}`);
        });
    }

    getProxy(id : ObjectId) : Proxy<unknown>|undefined {
        return this._knownProxies.get(id);
    }

    private async _handleCall(msg : CallMessage) {
        if (msg.id === undefined) {
            console.error('Malformed method call');
            return;
        }

        try {
            if (!this._knownStubIds.has(msg.obj))
                throw new InvalidObjectError(msg.obj, 'Invalid object 0x' + msg.obj.toString());

            if (!Array.isArray(msg.params))
                throw new TypeError('Malformed method call');

            const stub = this._knownStubs.get(this._knownStubIds.get(msg.obj)!)!;
            const unmarshalled = msg.params.map(this._unmarshalArgument.bind(this));
            const method = msg.method;

            let reply;
            if (method.substr(0,4) === 'get ') {
                if (unmarshalled.length !== 0)
                    throw new TypeError('Wrong number of arguments, expected 0');

                reply = await stub.get(method.substr(4));
            } else if (method.substr(0,4) === 'set ') {
                if (unmarshalled.length !== 1)
                    throw new TypeError('Wrong number of arguments, expected 1');

                stub.set(method.substr(4), unmarshalled[0]);
            } else {
                reply = await stub.call(method, unmarshalled);
            }
            if (msg.id !== null) {
                const replymsg : ReplyMessage = {
                    control:'reply',
                    id: msg.id,
                    reply: this._marshalArgument(reply)
                };
                this._socket.write(replymsg);
            }
        } catch(error) {
            if (this._ended)
                return;

            if (msg.id !== null) {
                let reply : ReplyMessage;

                if (error.name === 'SyntaxError') {
                    reply = {
                        control:'reply',
                        id: msg.id,
                        error: 'SyntaxError',
                        message: error.message,
                        stack: error.stack
                    };
                } else if (error.name === 'TypeError') {
                    reply = {
                        control:'reply',
                        id: msg.id,
                        error: 'TypeError',
                        message: error.message,
                        stack: error.stack
                    };
                } else if (error.message) {
                    reply = {
                        control:'reply',
                        id: msg.id,
                        error: error.message,
                        stack: error.stack,
                        code: error.code
                    };
                } else {
                    reply = {
                        control:'reply',
                        id: msg.id,
                        error: String(error)
                    };
                }
                this._socket.write(reply);
            } else {
                console.error('Discarded error from RPC call: ' + error.message);
            }
        }
    }

    private _handleReply(msg : ReplyMessage) {
        if (msg.id === undefined || msg.id === null) {
            console.error('Malformed method reply');
            return;
        }

        if (!this._pendingCalls.has(msg.id)) {
            console.error(msg.id + ' is not a pending method call');
            return;
        }

        const call = this._pendingCalls.get(msg.id)!;
        this._pendingCalls.delete(msg.id);
        try {
            if (msg.error) {
                let err;
                if (msg.error === 'SyntaxError')
                    err = new SyntaxError(msg.message);
                else if (msg.error === 'TypeError')
                    err = new TypeError(msg.message);
                else
                    err = new Error(msg.error);
                if (msg.code !== undefined)
                    (err as any).code = msg.code;
                if (msg.stack)
                    err.stack = msg.stack;
                throw err;
            }

            call.resolve(this._unmarshalArgument(msg.reply));
        } catch(e) {
            call.reject(e);
        }
    }

    private _handleFree(msg : FreeMessage) {
        const id = msg.id;
        if (this._knownStubIds.has(id))
            this._knownStubIds.delete(id);
        else
            this._knownProxies.delete(id);
    }

    private _handleMessage(msg : AnyMessage) {
        //console.log(this._socketId, msg);
        switch (msg.control) {
        case 'new-object': {
            if (this._knownProxies.has(msg.obj))
                return;

            const proxy = new RpcProxy(this, msg.obj, msg.methods);
            this._knownProxies.set(msg.obj, proxy);
            break;
        }

        case 'call':
            this._handleCall(msg);
            break;

        case 'reply':
            this._handleReply(msg);
            break;

        case 'free':
            this._handleFree(msg);
        }
    }
}

class RpcStub<Methods extends string = string> {
    $rpcId : ObjectId;
    object : Stubbable<Methods>;
    methods : readonly Methods[];

    constructor(object : Stubbable<Methods>, rpcId : ObjectId) {
        this.$rpcId = rpcId;
        this.object = object;
        this.methods = object.$rpcMethods;
    }

    private _validateCall(method : string) : asserts method is Methods {
        const methods : readonly string[] = this.methods;
        if (methods.indexOf(method) < 0)
            throw new TypeError('Invalid method ' + method);
    }

    get(name : string) {
        this._validateCall('get ' + name);
        return (this.object as any)[name];
    }

    set(name : string, value : any) {
        // NOTE: not a typo here, 'get foo' allows both get and set of foo
        this._validateCall('get ' + name);
        (this.object as any)[name] = value;
    }

    call(method : string, args : any[]) : any {
        this._validateCall(method);
        return (this.object as any)[method].apply(this.object, args);
    }
}


/**
 * The type of a value, as returned by an RPC call.
 *
 * Stubbable objects turn into proxies. Everything else goes through JSON;
 * we note this fact by removing properties that have function type.
 */
export type RpcMarshalOut<T> = T extends Stubbable<any> ? Proxy<T>
    : T extends null | undefined | string | number ? T
    : T extends Promise<infer T1> ? RpcMarshalOut<T1>
    : { [K in keyof T] : (T[K] extends ((...args : any[]) => any) ? never : T[K]) };

/**
 * The type of a value that can be passed to an RPC call.
 *
 * Stubbable objects turn into proxies. Either a proxy or the original object
 * can be passed.
 */
export type RpcMarshalIn<T> = T extends Stubbable ? (T|Proxy<T>) :
    T extends Proxy<infer Inner> ? (Inner|Proxy<Inner>) : T;

export type RpcMarshalArgs<Args extends unknown[]> = {
    [K in keyof Args] : RpcMarshalIn<Args[K]>
} & unknown[];

/**
 * The methods of an object that can be accessed as a proxy.
 *
 * This is potentially an over-approximation which can include all methods of T
 */
export type Methods<T> = T extends Stubbable<infer M> ? (keyof T & M) : keyof T;

/**
 * The type of a field on the proxy.
 *
 * If the underlying type is a function, this is a function with the same parameters
 * and a modified return type.
 * Otherwise, it is a promise of the getter.
 */
export type ProxyField<T, K extends keyof T> =
    T[K] extends ((...args : any[]) => any) ?
        (this : Proxy<T>, ...args : RpcMarshalArgs<Parameters<T[K]>>) => Promise<RpcMarshalOut<ReturnType<T[K]>>> :
        Promise<T[K]>;

export type Proxy<T> = {
    [K in Exclude<Methods<T>, '$free'>] : ProxyField<T, K>;
} & {
    $free() : void;
}

class RpcProxy {
    $rpcId : ObjectId;
    private _socket : RpcSocket;

    constructor(socket : RpcSocket, id : ObjectId, methods : readonly string[]) {
        this.$rpcId = id;
        this._socket = socket;

        methods.forEach((method) => {
            if (method.substr(0,4) === 'get ') {
                const name = method.substr(4);
                Object.defineProperty(this, name,
                                      { configurable: true,
                                        enumerable: true,
                                        get: function(this : RpcProxy) {
                                            return this._socket.call(this.$rpcId, 'get ' + name, []);
                                        }
                                      });
            } else {
                Object.defineProperty(this, method,
                    { configurable: true,
                      enumerable: true,
                      value: function(this : RpcProxy, ...args : unknown[]) {
                          return this._socket.call(this.$rpcId, method, args);
                      }
                    });
            }
        });
    }

    $free() {
        this._socket.freeProxy(this.$rpcId);
    }
}

export {
    RpcSocket as Socket,
};
