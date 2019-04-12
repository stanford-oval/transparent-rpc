/* -*- mode: js; indent-tabs-mode: nil; -*- */
//
// Copyright (c) 2019 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
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
"use strict";

process.on('unhandledRejection', (up) => { throw up; });
process.env.TEST_MODE = '1';

const assert = require('assert');
const Stream = require('stream');

const rpc = require('../lib/rpc_socket');

class MockSocket extends Stream.Duplex {
    constructor(options) {
        super(options);

        this.peer = null;
    }

    _read() {}

    _write(chunk, encoding, callback) {
        setImmediate(() => {
            this.peer.push(chunk);
            callback();
        });
    }
    _final(callback) {
        setImmediate(() => {
            this.peer.push(null);
            callback();
        });
    }
}
function socketpair(options) {
    const s1 = new MockSocket(options);
    const s2 = new MockSocket(options);
    s1.peer = s2;
    s2.peer = s1;
    return [s1, s2];
}

async function testBasic() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    const stubId = r2.addStub({
        $rpcMethods: ['frobnicate'],

        frobnicate(x) {
            assert.strictEqual(x, 'x');
            return 42;
        }
    });

    const result = await r1.call(stubId, 'frobnicate', ['x']);
    assert.strictEqual(result, 42);

    r1.end();
    r2.end();
}

async function testProxy() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    class MyObject {
        constructor(value) {
            this.value = value;
        }
        getValue() {
            return this.value;
        }

        frobnicate() {
            return 42;
        }

        hidden() {
            assert.fail('cannot call this');
        }
    }
    MyObject.prototype.$rpcMethods = ['frobnicate', 'getValue'];

    const stubId = r2.addStub({
        $rpcMethods: ['getObject'],

        getObject(value) {
            return new MyObject(value);
        }
    });

    const proxy1 = await r1.call(stubId, 'getObject', ['x']);
    assert(proxy1 instanceof rpc.Proxy);
    assert.strictEqual(typeof proxy1.getValue, 'function');
    assert.strictEqual(typeof proxy1.frobnicate, 'function');
    assert.strictEqual(typeof proxy1.hidden, 'undefined');

    const proxy2 = await r1.call(stubId, 'getObject', ['y']);
    assert(proxy2 instanceof rpc.Proxy);
    assert.strictEqual(typeof proxy2.getValue, 'function');
    assert.strictEqual(typeof proxy2.frobnicate, 'function');
    assert.strictEqual(typeof proxy2.hidden, 'undefined');

    assert(proxy1 !== proxy2);

    assert.strictEqual(await proxy1.getValue(), 'x');
    assert.strictEqual(await proxy2.getValue(), 'y');

    assert.strictEqual(await proxy1.frobnicate(), 42);
    assert.strictEqual(await proxy2.frobnicate(), 42);

    proxy1.$free();
    proxy2.$free();
}


async function testProxyOtherDirection() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    class MyObject {
        constructor(value) {
            this.value = value;
        }
        getValue() {
            return this.value;
        }

        frobnicate() {
            return 42;
        }

        hidden() {
            assert.fail('cannot call this');
        }
    }
    MyObject.prototype.$rpcMethods = ['frobnicate', 'getValue'];

    const stubId = r2.addStub({
        $rpcMethods: ['checkObject'],

        async checkObject(proxy, value) {
            assert(proxy instanceof rpc.Proxy);
            assert.strictEqual(typeof proxy.getValue, 'function');
            assert.strictEqual(typeof proxy.frobnicate, 'function');
            assert.strictEqual(typeof proxy.hidden, 'undefined');

            assert.strictEqual(await proxy.getValue(), value);
        }
    });

    await r1.call(stubId, 'checkObject', [new MyObject('x'), 'x']);
    await r1.call(stubId, 'checkObject', [new MyObject('y'), 'y']);
}

function isThenable(x) {
    return typeof x === 'object' && typeof x.then === 'function';
}

async function testMarshal() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    class MyObject {
        constructor(owner, value) {
            this._owner = owner;
            this.value = value;
        }
        get owner() {
            return this._owner;
        }
        getValue() {
            return this.value;
        }

        frobnicate() {
            return 42;
        }

        hidden() {
            assert.fail('cannot call this');
        }
    }
    MyObject.prototype.$rpcMethods = ['get owner', 'frobnicate', 'getValue'];

    const stubId = r2.addStub({
        $rpcMethods: ['getObject', 'checkObject'],

        async getObject() {
            return new MyObject(2, 'y');
        },

        async checkObject(stub, proxy, array, jsonObj, value) {
            assert(stub instanceof MyObject);
            assert.strictEqual(stub._owner, 2);
            assert.strictEqual(stub.owner, 2);
            assert.strictEqual(stub.value, 'y');
            assert.strictEqual(stub.getValue(), 'y');

            assert(proxy instanceof rpc.Proxy);
            assert.strictEqual(typeof proxy.getValue, 'function');
            assert.strictEqual(typeof proxy.frobnicate, 'function');
            assert.strictEqual(typeof proxy.hidden, 'undefined');

            assert(isThenable(proxy.owner));
            assert(isThenable(proxy.getValue()));
            assert.strictEqual(await proxy.owner, 1);
            assert.strictEqual(await proxy.getValue(), 'x');

            assert.strictEqual(array.length, 3);
            assert.strictEqual(array[0], stub);
            assert.strictEqual(array[1], proxy);
            assert.strictEqual(array[2], 7);

            assert.deepStrictEqual(jsonObj, {
                a: 'a',
                b: 'b',
                c: 3
            });

            assert.strictEqual(value, '72');

            return [stub, proxy, array, jsonObj, value];
        }
    });

    const proxy1 = await r1.call(stubId, 'getObject', []);
    const stub1 = new MyObject(1, 'x');

    const result = await r1.call(stubId, 'checkObject', [proxy1, stub1, [proxy1, stub1, 7], {
        a: 'a',
        b: 'b',
        c: 3
    }, '72']);
    assert.deepStrictEqual(result, [proxy1, stub1, [proxy1, stub1, 7], {
        a: 'a',
        b: 'b',
        c: 3
    }, '72']);

    proxy1.$free();
    stub1.$free();
}

async function testProxyFree() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    class MyObject {
        constructor(value) {
            this.value = value;
        }
        getValue() {
            return this.value;
        }
    }
    MyObject.prototype.$rpcMethods = ['getValue'];

    const stubId = r2.addStub({
        $rpcMethods: ['getObject'],

        _obj: new MyObject('x'),

        getObject() {
            return this._obj;
        }
    });

    const proxy1 = await r1.call(stubId, 'getObject', []);
    const proxy2 = await r1.call(stubId, 'getObject', []);
    assert.strictEqual(proxy2, proxy1);
    assert.strictEqual(await proxy1.getValue(), 'x');

    proxy1.$free();

    const proxy3 = await r1.call(stubId, 'getObject', []);
    assert(proxy3 !== proxy1);

    assert.strictEqual(await proxy3.getValue(), 'x');
}

async function testError() {
    const [s1, s2] = socketpair({ objectMode: true });

    const r1 = new rpc.Socket(s1);
    const r2 = new rpc.Socket(s2);

    class MyObject {
        frobnicate() {
            throw new TypeError('foo');
        }

        withCode() {
            const err = new Error('my error message');
            err.code = 'E_FOO_BAR_ERROR';
            throw err;
        }

        syntaxError() {
            JSON.parse('\n\ninvalid json');
        }
    }
    MyObject.prototype.$rpcMethods = ['frobnicate', 'withCode', 'syntaxError'];

    const stubId = r2.addStub({
        $rpcMethods: ['getObject'],

        _obj: new MyObject(),

        getObject() {
            return this._obj;
        }
    });

    const proxy = await r1.call(stubId, 'getObject', []);

    const promise = proxy.frobnicate();
    assert(isThenable(promise));

    await new Promise((resolve, reject) => {
        promise.then(() => {
            reject(new Error(`Expected error`));
        }, (e) => {
            assert.strictEqual(e.name, 'Error');
            assert.strictEqual(e.message, 'foo');
            assert(e.stack.split('\n')[1].indexOf('MyObject.frobnicate') >= 0);
            resolve();
        }).catch(reject);
    });

    const promise2 = proxy.withCode();
    assert(isThenable(promise2));

    await new Promise((resolve, reject) => {
        promise2.then(() => {
            reject(new Error(`Expected error`));
        }, (e) => {
            assert.strictEqual(e.name, 'Error');
            assert.strictEqual(e.message, 'my error message');
            assert.strictEqual(e.code, 'E_FOO_BAR_ERROR');
            resolve();
        }).catch(reject);
    });

    const promise3 = proxy.syntaxError();
    assert(isThenable(promise3));

    await new Promise((resolve, reject) => {
        promise3.then(() => {
            reject(new Error(`Expected error`));
        }, (e) => {
            assert.strictEqual(e.name, 'SyntaxError');
            resolve();
        }).catch(reject);
    });
}

async function main() {
    await testBasic();
    await testProxy();
    await testProxyOtherDirection();
    await testMarshal();
    await testProxyFree();
    await testError();
}
main();
