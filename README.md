# Disney Movie Trivia 🏰✨

A live, Kahoot-style Disney trivia party game for grown-up fans. One person **hosts**
on a big screen; up to **35 players** join from their phones with a 4-character room
code. **Speed and accuracy both count** — the faster you lock in a correct answer, the
more points you score, with bonus points for answer streaks.

- **Home** (`index.html`) — pick Host or Join
- **Host** (`host.html`) — big-screen controller: room code, live lobby, questions,
  answer reveal with a live vote breakdown, running leaderboard, and a final podium
- **Player** (`play.html`) — phone screen: join, tap answers, see your points & rank
- **36 questions** across Classics, Pixar, Villains, Songs, Voice Actors, and deep cuts
- The answer key lives on the server only — players can't peek in their browser

---

## How to put it online (one-time, ~5 minutes)

### 1. Create the project on Vercel
1. Go to **vercel.com** and log in.
2. Click **Add New… → Project**.
3. Import this `disney-trivia` folder (push it to GitHub first, or drag-and-drop the
   folder into Vercel).
4. Click **Deploy** and wait for the green "Congratulations" screen.

> The site is now live, but the game needs a shared database (step 2) before players
> can join.

### 2. Connect the cloud database (so everyone shares one game)
1. In your project on Vercel, click the **Storage** tab.
2. Click **Create Database → Upstash (Redis)** (sometimes shown as **KV**).
3. Name it anything, pick the closest region, click **Create**.
4. When asked, click **Connect** to link it to this project. Accept the defaults.
5. Go to the **Deployments** tab → **⋯** on the latest deployment → **Redeploy**.

That's it — the game is ready.

---

## How to run game night
1. On a TV, projector, or a shared Zoom/Meet window, open the site and click
   **🎬 Host a Game**.
2. Choose how many questions and seconds per question, then **Create Room**.
3. A big room code appears. Everyone else opens the site on their phone, taps
   **📱 Join a Game**, and enters that code + their name.
4. When everyone's in, click **Start Game**.
5. For each question: players tap an answer on their phone; the host screen shows the
   timer and how many have answered. Click **Reveal Answer Now** to end early, or let
   the clock run out (it reveals automatically).
6. The reveal shows the correct answer, how the room voted, a fun fact, and the
   standings. Click **Next Question**.
7. After the last question you get a podium and full ranking. **Play Again** keeps the
   same crowd and resets scores.

### Scoring
- Correct answer: **500–1000 points** — the faster you answer, the closer to 1000.
- **Streak bonus:** up to **+250** for a run of correct answers in a row.
- Wrong or no answer: 0 points.

---

## Tweaking the questions
Open `api/questions.js`. Each entry looks like:

```js
{
  q: "The question text",
  category: "Pixar",
  options: ["A", "B", "C", "D"],
  correct: 1,          // 0 = first option, 1 = second, etc.
  fact: "A fun blurb shown on the host screen at reveal time."
}
```

Add or edit entries, then redeploy (push to GitHub, or re-drag the folder into Vercel).

## Notes
- Player and host screens refresh every ~1.5 seconds. For a 35-player, 20-minute game
  that's well within Upstash's free tier — but if you run many long games back-to-back
  in one day, keep an eye on your Upstash usage dashboard.
- Games auto-expire from the database after 4 hours, so nothing piles up.
- Max 35 players is a soft party cap; the code allows a little headroom (40).
