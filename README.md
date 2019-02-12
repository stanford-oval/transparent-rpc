# Transparent RPC

Automatic Proxy-based RPC for Node.js

## How to use:

- Add `$rpcMethods` property to the prototype of the classes you want to export
- Create `rpc.Socket` object wrapping the transport layer (an object-mode stream supporting arbitrary objects)

  ````
  const rpc = require('transparent-rpc');
  let socket = new rpc.Socket(...);
  ````

- Publish the first stub object:

  ```
  let id = socket.addStub(mystub);
  ```

- Transmit the ID of the stub out of band
- Handle methods on the stub
- Objects received by the stub will be proxies
- Invoking a method on a proxy returns a promise for the execution of that method
- To publish more objects, return them from the stub's methods, or pass them them to remote proxy methods
