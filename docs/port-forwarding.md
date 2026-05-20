# Port Forwarding

For friends to connect to a local Host server, forward UDP traffic from your router to the hosting PC.

Default ports:

- `16261` game traffic
- `16262` Steam/auth traffic
- `8766` and `8767` compatibility/query ports

Also allow those UDP ports in Windows Firewall. The dashboard includes a firewall helper, but it may need to be run from an Administrator terminal.

Friends should connect to your public IPv4 address. If your ISP uses CGNAT, normal port forwarding may not work; use a tunnel or remote host.
