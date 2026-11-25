# Reverse proxy milestone

production.conf provides HTTPS termination, redirect, body limits, same-origin Next web/API routing and /events WebSocket forwarding. Production Compose mounts existing TLS certificates; no certificate is generated or committed. Docker/nginx/TLS execution is not locally verified. Development host ports remain loopback-only. See DEPLOYMENT.md.
