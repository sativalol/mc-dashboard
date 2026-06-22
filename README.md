# rack

basic minecraft server panel. runs your server natively as a background process and streams the logs to a web dashboard.

## features
- direct, instant native process management (no buggy screen/tmux layers)
- file manager (upload, edit, rename, delete, create backups)
- live terminal stream, send commands direct to console
- one-click plugin installation via Modrinth
- scheduled tasks / cron jobs 
- live metrics (cpu/ram)
- discord oauth whitelist login so randoms can't nuke your server

## requirements
- nodejs & npm
- git
- pm2 (recommended for keeping the dashboard alive)

## setup locally
1. `git clone https://github.com/sativalol/mc-dashboard.git`
2. `cd mc-dashboard && npm i`
3. copy `config.example.json` to `config.json`.
4. set env variables in a `.env` file:
   ```env
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback
   SESSION_SECRET=make-up-some-random-string
   ```
5. `npm start`

## vps deployment
getting this on a linux box is basically the same, just a few extra steps:
1. install the junk: `sudo apt update && sudo apt install nodejs npm git -y`
2. clone the repo and `npm i`
3. copy `config.example.json` to `config.json`. **important**: change `mcPath` to the absolute linux path of your server (e.g. `/home/mc/server`). don't use windows paths. update `startCmd` to whatever starts your server.
4. setup your `.env`. make sure `DISCORD_REDIRECT_URI` points to your VPS IP or domain (e.g. `http://YOUR_VPS_IP:3000/auth/callback`).
5. install pm2 so the dashboard doesn't die when you close ssh: `sudo npm i -g pm2`
6. run it: `pm2 start server.js --name "mc-dashboard"`
7. save it to restart on boot: `pm2 save && pm2 startup`

## troubleshooting

**"Invalid OAuth2 redirect_uri" on login**
your `.env` redirect uri doesn't exactly match what you put in the discord developer portal.
go to discord dev portal -> your app -> OAuth2 -> Redirects. make sure `http://YOUR_VPS_IP:3000/auth/callback` is added there and save changes.
