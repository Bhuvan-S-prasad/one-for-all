Agents work while you are away: routines run on a schedule, quiet checks watch for something, and agents set their own reminders and tasks for later.

## Routines

A routine is a standing job: instructions, a schedule and a time zone. Make one on the **Routines** page.

- **Schedule.** A five-field cron in your time zone (the workspace's by default), at most every 15 minutes, up to 50 per agent.
- **Its own chat.** Each routine posts in a chat of its own, so it never becomes your current chat with the agent.
- **Test run** runs it now; the page lists its last 20 runs.
- **Skipped, not queued.** A time is skipped when the agent is paused, its last run is still going, or the time was missed by more than an hour. Missed times are not caught up.
- **Paused when you're away.** Routines pause themselves after 14 days without you, and say so.
- **Your messages come first.** Writing to the agent sets its routine runs aside.

## Quiet checks

A routine of kind **check** looks without touching anything: it may use only read-only tools, never waits for an approval, and posts only when something needs you. If there is nothing to report, it stays silent. This is enforced by the policy engine, not by the prompt.

## Reminders and tasks for later

| Tool            | What it does                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `remind_me`     | Posts a reminder at the time you asked for. No model call: the reminder is posted as the agent's message, even if the agent is paused |
| `schedule_task` | Wakes the agent later, in the same chat, to do a piece of work                                                                        |

Each one sleeps durably until it is due (holding no process), and can be cancelled. A task set after outside content starts tainted.

## How it works underneath

```flow
routine-tick runs every minute | lists the routines that are due, across workspaces
!Each routine fires in one transaction | skip, pause or start, and move its next time on
A task posts its instructions | a check carries them on the run instead, posting nothing
The agent runs | the same durable run as a chat message
```

Reminders and tasks don't use the tick: each is a row that sleeps in its own durable function (`schedule-fire`) until it is due.
