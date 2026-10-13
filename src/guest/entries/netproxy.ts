// The sandbox's own proxy for network.allowOnly (runs detached for the sandbox's life, as sbx-netproxy.exe so the
// firewall can let only it out). HTTPS goes through CONNECT, plain HTTP as proxy requests; a host that is not allowed
// gets 403 and a line in logs\netproxy.log. With network.proxy set it hands everything on to that proxy.
// Usage: sbx-netproxy.exe netproxy.js
import { PROXY_PORT } from '../../shared/network/policy.js';
import { server } from '../network/proxy-server.js';

server.listen(PROXY_PORT, '127.0.0.1');
