# NEXUS Alarm

Alarms, reminders, timer and stopwatch. Part of the NEXUS app family (dark, glassy, blue/violet glow).

Live: https://olivercraftboycompany-design.github.io/NEXUS-Alarm/

- Alarms: time, label, repeat days (or once), sound (7 built-in tones made with WebAudio), snooze length, vibrate, on/off.
- Ringing screen with loud looping tone, vibration, big Stop / Snooze buttons.
- Nightstand mode keeps the screen on (Wake Lock) so alarms ring for real.
- Reminders: "in 10 min", "at 7:30 pm", tomorrow, or pick a time. Mark done / delete.
- Timer and stopwatch (with laps). Next-alarm countdown on the clock.
- Closed-app alerts: a web page can't ring when it's fully closed, so each install gets a private ntfy.sh topic. Alarms and reminders are sent as scheduled ntfy messages (up to 3 days ahead) and show up in the ntfy app at the right time. Deleting or turning off an alarm cancels its scheduled messages (DELETE on the scheduled message).
- Data: localStorage (nxalarm_*) on the phone only. Offline via service worker (nxalarm-v1).
