# Deploying to Oracle Cloud Always Free

Oracle's Always Free tier is the only free option that keeps a process
running permanently. Everywhere else, a free web service sleeps after a few
minutes idle — and when it sleeps the background worker stops, which means no
scanner sweeps, no news polling, no alert evaluation and no paper-trade
exits. That is most of what this platform does, so a real VM is the only free
arrangement where it behaves as designed.

This runs the whole stack — API, worker, PostgreSQL, Redis and HTTPS — on one
machine, at no cost, indefinitely.

---

## Before you start

You need a card for identity verification. Oracle does not charge it for
Always Free resources, but the account cannot be created without one.

You also need a hostname. A bare IP cannot have a Let's Encrypt certificate,
and the login page guards your broker credentials, so plain HTTP is not an
acceptable fallback. A free [DuckDNS](https://www.duckdns.org) subdomain is
fine — `yourname.duckdns.org` costs nothing and takes two minutes.

---

## 1. Create the instance

In the Oracle Cloud console: **Compute → Instances → Create instance**.

| Setting | Value | Why |
|---|---|---|
| Shape | **VM.Standard.A1.Flex** (Ampere ARM) | The Always Free ARM allowance is 4 OCPU / 24 GB. The AMD micro shapes are far smaller. |
| OCPUs / memory | 2 OCPU, 12 GB | Comfortable, and leaves headroom inside the free allowance. |
| Image | Ubuntu 22.04 or 24.04 | Any modern Linux works; these are what the commands below assume. |
| Boot volume | 50 GB | Always Free includes 200 GB total. |
| SSH keys | Upload or generate | Keep the private key safe; it is the only way in. |

**If you see "Out of host capacity"** — that is normal for the ARM shape in
busy regions, not an error on your part. Nothing in your setup is wrong; Oracle
simply has no free ARM hosts left in that region at that moment. In order of
how often each one works:

1. **Ask for less.** On the same Create instance page, under *Image and shape*
   press *Change shape* → *Ampere* → `VM.Standard.A1.Flex` and set **1 OCPU and
   6 GB** instead of 2 and 12. A smaller request fits a nearly full host. The
   app runs comfortably on this; raise it later from the instance's *Edit* menu
   when capacity is free.
2. **Try again at a quiet time.** Capacity is released as other people delete
   instances. Early morning IST (05:00–08:00) and late night succeed far more
   often than daytime. Press *Create* again with the same settings; nothing
   needs re-entering.
3. **Pick another availability domain**, if the region has more than one. Mumbai
   (`ap-mumbai-1`) has only one, so this choice is missing there; Hyderabad and
   most larger regions have three. Always Free compute only exists in your home
   region, so you cannot switch region for this.
4. **Upgrade the account to Pay As You Go.** Oracle gives paid-tier accounts
   priority for capacity, and Always Free resources stay free on a Pay As You Go
   account: you are only charged for what is outside the free allowance, so keep
   to one A1.Flex instance within 4 OCPU / 24 GB. *Billing → Upgrade and manage
   payment*. This is the step that most reliably ends a long run of capacity
   errors, but it does put a card on an account that can incur charges, so
   choose it deliberately.

Do not switch to the AMD `VM.Standard.E2.1.Micro` shape to get around it. It is
also Always Free but has 1 GB of memory, which is not enough for PostgreSQL, the
API and the worker together.

### Let a script keep trying for you

Clicking *Create* by hand at the right moment is a lottery. The repo has a script
that asks Oracle for the instance every few minutes, through the same API the
console uses, until a host is free. It needs an API key, which takes two minutes:

1. In the console click your profile icon (top right) → **My profile** →
   **API keys** → **Add API key** → *Generate API key pair* → **Download private
   key**, then **Add**.
2. Save the downloaded file as `C:\Users\<you>\.oci\oci_api_key.pem`.
3. The dialog shows a *Configuration file preview*. Copy it into
   `C:\Users\<you>\.oci\config` and set its `key_file=` line to the path from
   step 2.
4. If the tenancy has no network yet: **Networking → Virtual cloud networks →
   Start VCN Wizard → VCN with Internet Connectivity**, accept the defaults.
   (The Create instance page normally does this for you, but only when the
   instance is actually created.)

Then, from the project root, leave this running:

```bash
node scripts/oci-retry-create.mjs --ocpus 1 --memory 6 --every 3
```

It discovers the availability domain, the Ubuntu 24.04 ARM image and your
public subnet, retries every 3 minutes, and when the instance is granted prints
its public IP and the next steps. Stop it with Ctrl+C. It uses the SSH key at
`~/.ssh/advisha_oracle.pub` by default; pass `--ssh <path>` for another.

---

## 2. Open the ports

Two places have to agree, and forgetting the second is the usual reason a
deployment appears dead.

**Oracle's virtual firewall** — VCN → your subnet → Security List → add
ingress rules for TCP **80** and **443** from `0.0.0.0/0`.

**The VM's own firewall** — Ubuntu images ship with iptables rules that drop
everything else:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Do **not** open 5432 or 6379. The compose file keeps PostgreSQL and Redis on
the internal network, reachable only by the app containers. A database
exposed to the internet is found by scanners within hours.

---

## 3. Point the hostname at the VM

Set your DuckDNS (or other) record to the instance's public IP. Confirm it
has propagated before continuing, because Caddy's certificate request will
fail if the name does not yet resolve:

```bash
dig +short yourname.duckdns.org
```

---

## 4. Install Docker

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# So you can run docker without sudo. Log out and back in afterwards.
sudo usermod -aG docker $USER
```

---

## 5. Get the code and write the secrets

```bash
git clone https://github.com/jeevamani502-hue/portfolio-management.git
cd portfolio-management
cp .env.prod.example .env.prod
```

Generate each secret **on the server** and paste it in:

```bash
openssl rand -base64 32   # POSTGRES_PASSWORD
openssl rand -base64 32   # JWT_ACCESS_SECRET
openssl rand -base64 32   # JWT_REFRESH_SECRET
openssl rand -base64 32   # CREDENTIAL_ENC_KEY
```

Set `DOMAIN` to your hostname and `ACME_EMAIL` to a real address — Let's
Encrypt uses it for expiry warnings.

> **`CREDENTIAL_ENC_KEY` is the one to be careful with.** It encrypts your
> broker credentials. Change it and every saved credential becomes
> undecryptable and has to be entered again. Back it up somewhere safe.

Broker credentials themselves do **not** go in this file. Enter them in the
running app, where they are encrypted at rest.

---

## 6. Start it

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The first build takes several minutes on ARM. Then apply the schema:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec app node dist/db/migrate.js up

docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec app node dist/db/seed.js
```

Check it:

```bash
curl -s https://yourname.duckdns.org/health
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

`/health` reports database and Redis reachability, not merely that the
process is alive — so an `ok` from it means the stack is genuinely wired up.

---

## 7. First run in the browser

1. Open `https://yourname.duckdns.org` and create your account. **Use a long,
   unique password** — this login stands between the internet and an
   application holding your brokerage credentials.
2. **Settings → Market data providers** → enter your Angel One API key,
   client code, MPIN and TOTP secret.
3. The worker syncs the instrument master on boot; give it a few minutes.

---

## Running it

```bash
# Logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f app
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f worker

# Update to the latest code
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod exec app node dist/db/migrate.js up

# Back up the database. Worth doing before any upgrade: it holds your
# encrypted broker credentials and your paper-trading history.
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -U market market_ai | gzip > backup-$(date +%F).sql.gz
```

---

## What this costs and what it does not

Nothing, indefinitely, within the Always Free allowance: 4 ARM OCPUs, 24 GB
RAM, 200 GB storage, 10 TB egress a month. This stack uses a fraction of it.

Oracle reclaims **idle** Always Free compute instances, but "idle" means
almost no CPU or network for a week. A worker polling the market all day is
nowhere near that threshold.

What it does not buy you: market data. Angel One's free tier still supplies
the prices, and the SEBI algo rules still apply to automated order placement.
Hosting changes where the app runs, not what it is allowed to do.
