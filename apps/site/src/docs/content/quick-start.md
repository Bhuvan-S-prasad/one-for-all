The self-host bundle runs the whole system on one machine with Docker Compose: the app, Postgres, the Inngest engine, the agents' sandbox and its egress proxy.

## What you need

- **Docker** with Compose v2.
- **About 3 GB of free memory** once agents are at work. The app on its own uses far less.
- **An x86-64 or arm64 machine.** A spare laptop, a Mac mini, a Raspberry Pi 5 with 8 GB, or an Oracle Cloud Always Free VM all work.
- **An OpenRouter key** for the models. Free models work; you add the key after signing in.

## Install

```sh
git clone https://github.com/Bhuvan-S-prasad/one-for-all.git
cd one-for-all

# 1. Generate secrets into infra/compose/.env (run once; it never overwrites)
sh infra/scripts/init-env.sh

# 2. Build and start everything
docker compose -f infra/compose/docker-compose.selfhost.yml up -d --build
```

On Windows, run the first step in Git Bash or WSL. The first build also builds the agents' sandbox image, which takes several minutes.

## Sign in for the first time

Open **http://localhost:3000**. The first visit shows a setup page that creates the owner account. You choose every value yourself:

| Field          | What to enter                                                                     |
| -------------- | --------------------------------------------------------------------------------- |
| Your name      | How agents and the app address you                                                |
| Workspace name | Anything, for example "Home"                                                      |
| Email          | The email you will sign in with. It is only a sign-in name: nothing is sent to it |
| Password       | A password of your choosing                                                       |

After that, public sign-up closes: only the owner can sign in, and the setup page never appears again.

## Add a model key and hatch an agent

1. Open **Settings** and add your OpenRouter key. It is stored encrypted in your database.
2. Open **Agents** and hatch your first agent: give it a job, standing rules, a voice and a familiar, then choose its tools.
3. Write to it in its chat.

## Keep `infra/compose/.env` private

The file holds the database passwords and `VAULT_KEY`, which encrypts every stored credential. Back it up somewhere private: losing it means losing access to your saved keys and sign-ins. To rotate `VAULT_KEY`, put a new key in it, move the old one to `VAULT_PREVIOUS_KEYS`, and restart; the app re-wraps everything and logs when the old key can go.

## Local only, by default

The app is published on `127.0.0.1` only, so other devices on your network cannot reach it. Postgres and Inngest are not published at all. The app also rejects requests whose `Host` or `Origin` it does not recognise, which stops other web pages from talking to it through your browser. To use a different port, change `APP_PORT` and `APP_URL` in `infra/compose/.env` together.

## Everyday commands

```sh
docker compose -f infra/compose/docker-compose.selfhost.yml ps        # status
docker compose -f infra/compose/docker-compose.selfhost.yml logs -f   # logs
docker compose -f infra/compose/docker-compose.selfhost.yml down      # stop (data is kept)
docker compose -f infra/compose/docker-compose.selfhost.yml up -d --build   # update after pulling
```

Database migrations run by themselves when the app starts.
