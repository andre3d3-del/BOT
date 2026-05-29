# Deploy on Ubuntu VPS (Vite + React) with Login Prompt (Basic Auth)

This project is a Vite + React app. The production approach is:

- Build static files (`dist/`)
- Serve them with **Nginx**
- Protect the site with **username/password** using **Nginx Basic Auth**

> Note: `0.0.0.0` is a bind address, not a URL. In a browser, use your VPS public IP:
>
> - `http://177.7.46.191`

---

## 1) SSH into the VPS

From your local machine:

```bash
ssh root@177.7.46.191
```

---

## 2) Update Ubuntu packages

```bash
apt update && apt upgrade -y
```

Install base tools + Nginx:

```bash
apt install -y curl git ufw nginx
```

---

## 3) Create a non-root user (recommended)

```bash
adduser deploy
usermod -aG sudo deploy
```

Switch to the new user:

```bash
su - deploy
```

---

## 4) Install Node.js (LTS) and Yarn (optional)

Install Node.js 20 LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify:

```bash
node -v
npm -v
```

Optional: install Yarn globally:

```bash
sudo npm install -g yarn
yarn -v
```

---

## 5) Get the project onto the VPS

### Option A: Clone from GitHub

```bash
sudo mkdir -p /var/www
cd /var/www
git clone <YOUR_GITHUB_REPO_URL> Binance-Trading-Bot
cd Binance-Trading-Bot
```

### Option B: Upload files (SCP/SFTP)

Upload the project into:

```text
/var/www/Binance-Trading-Bot
```

Then:

```bash
cd /var/www/Binance-Trading-Bot
```

---

## 6) Install dependencies and build the production output

Using npm:

```bash
npm install
npm run build
```

Using yarn:

```bash
yarn
yarn build
```

After a successful build, you should have:

```text
dist/
```

Also run the Binance proxy API (required for trading calls from VPS IP):

```bash
npm run start:api
```

You should see:

```text
Binance proxy listening on http://127.0.0.1:3001
```

Press `Ctrl + C` for now. We will run it as a background service in the next step.

---

## 7) Run Binance proxy API as a service (systemd)

Create a systemd unit:

```bash
sudo nano /etc/systemd/system/binance-proxy.service
```

Paste:

```ini
[Unit]
Description=Binance Proxy API for Trading Bot
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/var/www/Binance-Trading-Bot
ExecStart=/usr/bin/node /var/www/Binance-Trading-Bot/server/binance-proxy.mjs
Restart=always
RestartSec=3
Environment=BINANCE_PROXY_PORT=3001

[Install]
WantedBy=multi-user.target
```

Enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now binance-proxy
sudo systemctl status binance-proxy --no-pager
```

---

## 8) Configure Nginx to serve app + proxy API

Create an Nginx site config:

```bash
sudo nano /etc/nginx/sites-available/binace-trading-bot
```

Paste (this is the correct config for your current VPS IP and project path):

```nginx
server {
    listen 80;
    server_name 177.7.46.191;

    root /var/www/Binance-Trading-Bot/dist;
    index index.html;

    # Backend proxy for Binance signed/public requests.
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # React Router fallback
    location / {
        try_files $uri /index.html;
    }
}
```

Why this is correct:

- `server_name` must match your VPS IP: `177.7.46.191`
- Vite production output is in `dist/`, so `root` must point to that folder

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/binace-trading-bot /etc/nginx/sites-enabled/
```

Disable the default site (optional but recommended):

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

Test and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 9) Add username/password protection (Basic Auth)

Expected user experience after this step:

1. User visits `http://177.7.46.191` (or your server IP).
2. Browser shows the native username/password login popup.
3. User enters correct credentials from `/etc/nginx/.htpasswd`.
4. Site loads only after successful login.

This is browser-level authentication (Nginx Basic Auth), not a React modal in the page.

Install `htpasswd`:

```bash
sudo apt install -y apache2-utils
```

Create the password file (replace `myadmin` with your username):

```bash
sudo htpasswd -c /etc/nginx/.htpasswd myadmin
```

Edit your Nginx site to require login:

```bash
sudo nano /etc/nginx/sites-available/binace-trading-bot
```

Update the `location /` block like this:

```nginx
location / {
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;

    try_files $uri /index.html;
}
```

And protect API routes too:

```nginx
location /api/ {
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;

    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Now when you visit the site, the browser will prompt for username/password.

---

## 10) Configure firewall (UFW)

Allow SSH and web traffic:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## 11) Access the site

Open in your browser:

- `http://177.7.46.191` (example)

You should see a login prompt (Basic Auth), then the app.

If no login popup appears, double-check that `auth_basic` lines are inside `location /` in your active Nginx site file and run:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 12) Update / redeploy after code changes

From the VPS:

```bash
cd /var/www/Binance-Trading-Bot
git pull
npm install
npm run build
sudo systemctl reload nginx
sudo systemctl restart binance-proxy
```

If you use yarn:

```bash
cd /var/www/Binance-Trading-Bot
git pull
yarn
yarn build
sudo systemctl reload nginx
sudo systemctl restart binance-proxy
```

---

## Troubleshooting

### Nginx config test fails

```bash
sudo nginx -t
```

### Nginx fails to start with `bind() ... :80 failed (98: Address already in use)`

Another service is already using port 80 (often Docker or Apache).

Check what is using port 80:

```bash
sudo lsof -i :80 -P -n
```

If it is Docker (`docker-pr`), stop the conflicting container first:

```bash
sudo docker ps --format "table {{.ID}}\t{{.Names}}\t{{.Ports}}"
sudo docker stop <CONTAINER_ID_OR_NAME>
```

Then start Nginx:

```bash
sudo systemctl start nginx
sudo systemctl status nginx --no-pager
```

### Nginx not serving latest build

- Confirm `dist/` exists and was rebuilt:
  - `npm run build` or `yarn build`
- Reload Nginx:
  - `sudo systemctl reload nginx`

### “403 Forbidden” or permission errors

- Confirm the `root` path exists and is correct:
  - `/var/www/Binance-Trading-Bot/dist`

