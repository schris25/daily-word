(() => {
  'use strict';

  // ---- Settings you can tune -------------------------------------------------

  const GAME_NAME = 'GuessIT';
  const WORD_LENGTH = 5;
  const FIRST_DAY = Date.UTC(2026, 9, 1); // the date of puzzle #1 (months count from 0)

  // One level per weekday, Monday (level 1) to Sunday (level 7).
  // guesses: how many tries the player gets. hardRules: letters already found must be reused.
  const LEVELS = [
    { day: 'Monday', name: 'Easy', guesses: 7, hardRules: false },
    { day: 'Tuesday', name: 'Gentle', guesses: 6, hardRules: false },
    { day: 'Wednesday', name: 'Steady', guesses: 6, hardRules: false },
    { day: 'Thursday', name: 'Tricky', guesses: 6, hardRules: false },
    { day: 'Friday', name: 'Tough', guesses: 6, hardRules: false },
    { day: 'Saturday', name: 'Fierce', guesses: 6, hardRules: false },
    { day: 'Sunday', name: 'Brutal', guesses: 6, hardRules: true },
  ];
  const MOST_GUESSES = Math.max(...LEVELS.map((level) => level.guesses));

  const WIN_MESSAGES = ['Unreal!', 'Incredible!', 'Superb!', 'Sharp!', 'Nailed it!', 'Got there!', 'Just in time!'];
  const KEY_ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['enter', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'back'],
  ];

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FLIP_MS = reducedMotion ? 0 : 300;
  const FLIP_GAP_MS = reducedMotion ? 0 : 220;

  const TIERS = window.ANSWER_TIERS;
  const VALID = new Set([...TIERS.flat(), ...window.VALID_GUESSES.split(' ')]);

  // ---- Saved data (kept in this browser only) --------------------------------

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('daily-word:' + key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('daily-word:' + key, JSON.stringify(value));
      } catch {
        // Storage can be unavailable (private window); the game still works without it.
      }
    },
  };

  // Guesses for every puzzle played, by day number: { [day]: { answer, guesses } }.
  function loadProgress() {
    const progress = store.get('progress', null);
    if (progress) return progress;
    // Older versions saved only today's puzzle.
    const saved = store.get('daily', null);
    return saved && saved.answer ? { [saved.day]: { answer: saved.answer, guesses: saved.guesses } } : {};
  }

  function saveProgress(day, answer, guesses) {
    const progress = loadProgress();
    progress[day] = { answer, guesses };
    store.set('progress', progress);
  }

  // A saved game only counts if it was played against the word that day has now.
  function savedGuesses(day, progress = loadProgress()) {
    const saved = progress[day];
    return saved && saved.answer === answerForDay(day) ? saved.guesses : [];
  }

  function loadStats() {
    const stats = store.get('stats', null) || {
      played: 0, wins: 0, streak: 0, best: 0, lastWinDay: null, lastPlayedDay: null, distribution: [],
    };
    // Older saves had room for fewer guesses.
    while (stats.distribution.length < MOST_GUESSES) stats.distribution.push(0);
    if (stats.lastPlayedDay === undefined) stats.lastPlayedDay = null;
    return stats;
  }

  // ---- Game rules -------------------------------------------------------------

  // Days since puzzle #1, using the player's local calendar date.
  function dayNumber() {
    const now = new Date();
    return Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - FIRST_DAY) / 86400000);
  }

  // 1 (Monday) to 7 (Sunday).
  function levelOfDay(day) {
    const weekday = new Date(FIRST_DAY + day * 86400000).getUTCDay();
    return weekday === 0 ? 7 : weekday;
  }

  // Each weekday comes round once every 7 days, so day / 7 steps through its level's list one word at a time.
  function answerForDay(day) {
    const tier = TIERS[levelOfDay(day) - 1];
    return tier[Math.floor(day / 7) % tier.length];
  }

  // Returns 'correct' | 'present' | 'absent' for each letter of the guess.
  // Exact matches are claimed first so repeated letters are not over-counted.
  function scoreGuess(guess, answer) {
    const result = Array(WORD_LENGTH).fill('absent');
    const unmatched = {};
    for (let i = 0; i < WORD_LENGTH; i++) {
      if (guess[i] === answer[i]) result[i] = 'correct';
      else unmatched[answer[i]] = (unmatched[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < WORD_LENGTH; i++) {
      if (result[i] !== 'correct' && unmatched[guess[i]] > 0) {
        result[i] = 'present';
        unmatched[guess[i]]--;
      }
    }
    return result;
  }

  // Hard rules: every letter found so far must be used again, and found positions kept.
  // Returns a message describing the first rule broken, or null.
  function hardRulesProblem(guess) {
    const ordinal = ['1st', '2nd', '3rd', '4th', '5th'];
    for (const previous of state.guesses) {
      const result = scoreGuess(previous, state.answer);
      for (let i = 0; i < WORD_LENGTH; i++) {
        if (result[i] === 'correct' && guess[i] !== previous[i]) {
          return `${ordinal[i]} letter must be ${previous[i].toUpperCase()}`;
        }
      }
      const needed = {};
      result.forEach((r, i) => { if (r !== 'absent') needed[previous[i]] = (needed[previous[i]] || 0) + 1; });
      for (const [letter, count] of Object.entries(needed)) {
        if (guess.split(letter).length - 1 < count) return `Guess must contain ${letter.toUpperCase()}`;
      }
    }
    return null;
  }

  function statusOf(guesses, answer, maxGuesses) {
    if (guesses.includes(answer)) return 'won';
    if (guesses.length >= maxGuesses) return 'lost';
    return 'playing';
  }

  // ---- State --------------------------------------------------------------------

  let state;
  let busy = false; // true while tiles are flipping

  function newState(mode, day, level, answer, guesses) {
    const { guesses: maxGuesses } = LEVELS[level - 1];
    return { mode, day, level, answer, maxGuesses, guesses, current: '', status: statusOf(guesses, answer, maxGuesses) };
  }

  // Play the puzzle of any day from #1 to today. Only today's result counts towards the statistics.
  function startDay(day) {
    const today = dayNumber();
    const answer = answerForDay(day);
    if (day === today) {
      const legacy = store.get('daily', null);
      if (legacy && legacy.day === day && legacy.answer !== answer && legacy.guesses.length) {
        // Progress from before the word lists changed: today's word is now different,
        // so start again but do not count today in the statistics twice.
        const stats = loadStats();
        stats.lastPlayedDay = day;
        store.set('stats', stats);
      }
    }
    state = newState('daily', day, levelOfDay(day), answer, savedGuesses(day));
    state.isToday = day === today;
    buildBoard();
    render();
  }

  function startDaily() {
    startDay(dayNumber());
  }

  function startPractice() {
    const todays = answerForDay(dayNumber());
    const level = 1 + Math.floor(Math.random() * LEVELS.length);
    const tier = TIERS[level - 1];
    let answer;
    do {
      answer = tier[Math.floor(Math.random() * tier.length)];
    } while (answer === todays || (state && answer === state.answer));
    state = newState('practice', null, level, answer, []);
    buildBoard();
    render();
  }

  function recordDailyResult() {
    const stats = loadStats();
    if (stats.lastPlayedDay === state.day) return;
    stats.played++;
    stats.lastPlayedDay = state.day;
    if (state.status === 'won') {
      stats.wins++;
      stats.streak = stats.lastWinDay === state.day - 1 ? stats.streak + 1 : 1;
      stats.best = Math.max(stats.best, stats.streak);
      stats.lastWinDay = state.day;
      stats.distribution[state.guesses.length - 1]++;
    } else {
      stats.streak = 0;
    }
    store.set('stats', stats);
  }

  // ---- Input ----------------------------------------------------------------------

  function addLetter(letter) {
    if (state.current.length >= WORD_LENGTH) return;
    state.current += letter;
    render();
  }

  function removeLetter() {
    state.current = state.current.slice(0, -1);
    render();
  }

  function submitGuess() {
    const guess = state.current;
    if (guess.length < WORD_LENGTH) return reject('Not enough letters');
    if (!VALID.has(guess)) return reject('Not in word list');
    if (LEVELS[state.level - 1].hardRules) {
      const problem = hardRulesProblem(guess);
      if (problem) return reject(problem);
    }

    const rowIndex = state.guesses.length;
    state.guesses.push(guess);
    state.current = '';
    state.status = statusOf(state.guesses, state.answer, state.maxGuesses);
    if (state.mode === 'daily') {
      saveProgress(state.day, state.answer, state.guesses);
      if (state.status !== 'playing' && state.isToday) recordDailyResult();
    }

    busy = true;
    revealRow(rowIndex, scoreGuess(guess, state.answer), () => {
      busy = false;
      render();
      if (state.status === 'won') {
        const left = state.maxGuesses - state.guesses.length;
        showToast(WIN_MESSAGES[Math.max(0, WIN_MESSAGES.length - 1 - left)]);
      }
      if (state.status === 'lost') showToast('The word was ' + state.answer.toUpperCase(), 4000);
      if (state.status !== 'playing') setTimeout(openStats, reducedMotion ? 0 : 1400);
    });
  }

  function reject(message) {
    showToast(message);
    const row = rows[state.guesses.length];
    row.classList.remove('shake');
    void row.offsetWidth; // restart the animation if it is already running
    row.classList.add('shake');
  }

  function press(key) {
    if (busy || state.status !== 'playing') return;
    if (key === 'enter') submitGuess();
    else if (key === 'back') removeLetter();
    else addLetter(key);
  }

  // ---- Drawing --------------------------------------------------------------------

  const board = document.getElementById('board');
  const keyboard = document.getElementById('keyboard');
  const subtitle = document.getElementById('subtitle');
  const levelBar = document.getElementById('level-bar');
  const modeBar = document.getElementById('mode-bar');
  const toast = document.getElementById('toast');
  const helpDialog = document.getElementById('help-dialog');
  const statsDialog = document.getElementById('stats-dialog');
  const rows = [];
  const keys = {};

  // The board has one row per allowed guess, so it is rebuilt for each game.
  function buildBoard() {
    board.replaceChildren();
    rows.length = 0;
    document.documentElement.style.setProperty('--rows', state.maxGuesses);
    for (let r = 0; r < state.maxGuesses; r++) {
      const row = document.createElement('div');
      row.className = 'row';
      for (let c = 0; c < WORD_LENGTH; c++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        row.append(tile);
      }
      board.append(row);
      rows.push(row);
    }
  }

  function buildKeyboard() {
    KEY_ROWS.forEach((letters, index) => {
      const row = document.createElement('div');
      row.className = 'key-row';
      if (index === 1) row.append(spacer());
      for (const key of letters) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'key';
        if (key === 'enter') {
          button.textContent = 'Enter';
          button.classList.add('wide');
        } else if (key === 'back') {
          button.textContent = '⌫';
          button.setAttribute('aria-label', 'Delete');
          button.classList.add('wide');
        } else {
          button.textContent = key;
        }
        button.addEventListener('click', () => {
          press(key);
          button.blur(); // so the physical Enter key does not re-press this button
        });
        keys[key] = button;
        row.append(button);
      }
      if (index === 1) row.append(spacer());
      keyboard.append(row);
    });
  }

  function spacer() {
    const el = document.createElement('div');
    el.className = 'spacer';
    return el;
  }

  function render() {
    // Board
    rows.forEach((row, r) => {
      const guess = state.guesses[r];
      const letters = guess || (r === state.guesses.length ? state.current : '');
      const result = guess ? scoreGuess(guess, state.answer) : null;
      [...row.children].forEach((tile, c) => {
        const letter = letters[c] || '';
        tile.className = 'tile';
        tile.textContent = letter;
        tile.dataset.state = result ? result[c] : letter ? 'filled' : 'empty';
      });
    });

    // Keyboard: a key shows the best information known about its letter.
    const rank = { absent: 1, present: 2, correct: 3 };
    const best = {};
    for (const guess of state.guesses) {
      scoreGuess(guess, state.answer).forEach((result, i) => {
        const letter = guess[i];
        if (!best[letter] || rank[result] > rank[best[letter]]) best[letter] = result;
      });
    }
    for (const [key, button] of Object.entries(keys)) {
      if (best[key]) button.dataset.state = best[key];
      else delete button.dataset.state;
    }

    // Header, difficulty and mode buttons
    const level = LEVELS[state.level - 1];
    if (state.mode === 'practice') subtitle.textContent = 'Practice round';
    else if (state.isToday) subtitle.textContent = `#${state.day + 1} · ${level.day}`;
    else subtitle.textContent = `#${state.day + 1} · ${formatDate(state.day, { weekday: 'short', day: 'numeric', month: 'short' })}`;
    renderLevelBar(level);
    modeBar.replaceChildren();
    if (state.mode === 'practice') {
      modeBar.append(modeButton('New word', startPractice), modeButton("Back to today's puzzle", startDaily));
    } else if (state.isToday) {
      modeBar.append(modeButton('Practice round', startPractice), modeButton('Past puzzles', openArchive));
    } else {
      modeBar.append(modeButton('Past puzzles', openArchive), modeButton("Back to today's puzzle", startDaily));
    }
  }

  function renderLevelBar(level) {
    const pips = document.createElement('div');
    pips.className = 'pips';
    pips.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= LEVELS.length; i++) {
      const pip = document.createElement('span');
      pip.className = 'pip' + (i <= state.level ? ' on' : '');
      pips.append(pip);
    }
    const label = document.createElement('span');
    label.className = 'level-label';
    label.textContent = `Level ${state.level} · ${level.name}`;
    const parts = [pips, label];
    if (level.guesses > 6) parts.push(badge('+1 guess'));
    if (level.hardRules) parts.push(badge('Hard rules'));
    levelBar.replaceChildren(...parts);
    levelBar.setAttribute('aria-label', `Difficulty level ${state.level} of ${LEVELS.length}, ${level.name}`);
  }

  function badge(text) {
    const el = document.createElement('span');
    el.className = 'badge';
    el.textContent = text;
    return el;
  }

  function modeButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (busy) return;
      onClick();
    });
    return button;
  }

  function revealRow(rowIndex, result, done) {
    [...rows[rowIndex].children].forEach((tile, i) => {
      setTimeout(() => {
        tile.classList.add('flip');
        setTimeout(() => { tile.dataset.state = result[i]; }, FLIP_MS / 2);
      }, i * FLIP_GAP_MS);
    });
    setTimeout(done, (WORD_LENGTH - 1) * FLIP_GAP_MS + FLIP_MS);
  }

  let toastTimer;
  function showToast(message, duration = 1600) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
  }

  // ---- Statistics and sharing -----------------------------------------------------

  let countdownTimer;

  function openStats() {
    const stats = loadStats();
    document.getElementById('stat-played').textContent = stats.played;
    document.getElementById('stat-win-rate').textContent = stats.played ? Math.round((stats.wins / stats.played) * 100) : 0;
    document.getElementById('stat-streak').textContent = stats.streak;
    document.getElementById('stat-best').textContent = stats.best;

    const resultLine = document.getElementById('result-line');
    const label = state.mode === 'practice' ? 'the practice word' : state.isToday ? "today's word" : `puzzle #${state.day + 1}`;
    if (state.status === 'won') {
      const n = state.guesses.length;
      resultLine.textContent = `You solved ${label} (level ${state.level}) in ${n} ${n === 1 ? 'guess' : 'guesses'}.`;
    } else if (state.status === 'lost') {
      resultLine.textContent = `Out of guesses. The word was ${state.answer.toUpperCase()}.`;
    } else {
      resultLine.textContent = '';
    }

    const distribution = document.getElementById('distribution');
    const max = Math.max(1, ...stats.distribution);
    const highlight = state.isToday && state.status === 'won' ? state.guesses.length - 1 : -1;
    distribution.replaceChildren(...stats.distribution.map((count, i) => {
      const row = document.createElement('div');
      row.className = 'dist-row';
      const number = document.createElement('span');
      number.textContent = i + 1;
      const bar = document.createElement('div');
      bar.className = 'bar' + (i === highlight ? ' current' : '');
      bar.style.width = Math.round((count / max) * 100) + '%';
      bar.textContent = count;
      row.append(number, bar);
      return row;
    }));

    const tomorrow = LEVELS[levelOfDay(dayNumber() + 1) - 1];
    document.getElementById('next-level').textContent = `level ${levelOfDay(dayNumber() + 1)}, ${tomorrow.name.toLowerCase()}`;
    document.getElementById('share-button').hidden = state.status === 'playing';
    shareImage = null;
    const fallback = document.getElementById('share-fallback');
    if (fallback) fallback.hidden = true;
    if (state.status !== 'playing') prepareShareImage();
    updateCountdown();
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    if (!statsDialog.open) statsDialog.showModal();
  }

  function updateCountdown() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const seconds = Math.max(0, Math.floor((midnight - now) / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    document.getElementById('countdown').textContent =
      `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
  }

  // The shared result is a picture of the coloured grid, without letters so it does not give the word away.
  const IMAGE_SIZE = 1080;
  const IMAGE_FONT = 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const IMAGE_COLOURS = { correct: '#14b8a6', present: '#f5843a', absent: '#4a4470' };
  const PIP_COLOURS = ['#10b3a3', '#2fa4d4', '#4b84f5', '#6c5cff', '#9b4ff2', '#d24bc6', '#ff4f8b'];

  let shareImage = null; // { blob: Promise<Blob>, file: File | null } for the finished game

  // The message that travels with the picture (pictures cannot hold a link, so the link goes here).
  function shareCaption() {
    const link = location.href.split(/[?#]/)[0];
    const puzzle = state.mode === 'daily'
      ? `${GAME_NAME} #${state.day + 1} (level ${state.level} of ${LEVELS.length})`
      : `a level ${state.level} ${GAME_NAME} practice word`;
    if (state.status === 'won') return `I solved ${puzzle} in ${state.guesses.length}/${state.maxGuesses}. Can you beat that?\n${link}`;
    if (state.status === 'lost') return `${puzzle.charAt(0).toUpperCase() + puzzle.slice(1)} beat me. Can you solve it?\n${link}`;
    return `Play ${GAME_NAME}, the daily word puzzle that gets harder every day:\n${link}`;
  }

  function copyLink() {
    const text = shareCaption();
    navigator.clipboard.writeText(text)
      .then(() => showToast('Link copied. Paste it next to your picture', 2600))
      .catch(() => showToast('Could not copy. The link is ' + text.split('\n').pop(), 4000));
  }

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawResultImage() {
    const S = IMAGE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    const level = LEVELS[state.level - 1];

    // Background with a soft glow at the top
    const bg = ctx.createLinearGradient(0, 0, 0, S);
    bg.addColorStop(0, '#221a4a');
    bg.addColorStop(1, '#120f24');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, S, S);
    const glow = ctx.createRadialGradient(S / 2, 0, 0, S / 2, 0, S * 0.7);
    glow.addColorStop(0, 'rgba(108, 71, 255, 0.35)');
    glow.addColorStop(1, 'rgba(108, 71, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, S, S);

    // Logo: "Guess" followed by a tilted gradient "IT" badge
    ctx.textBaseline = 'middle';
    ctx.font = `800 92px ${IMAGE_FONT}`;
    const guessWidth = ctx.measureText('Guess').width;
    const itWidth = ctx.measureText('IT').width + 36;
    const logoX = (S - guessWidth - 14 - itWidth) / 2;
    const logoY = 110;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText('Guess', logoX, logoY);
    ctx.save();
    ctx.translate(logoX + guessWidth + 14 + itWidth / 2, logoY);
    ctx.rotate(-4 * Math.PI / 180);
    const badge = ctx.createLinearGradient(-itWidth / 2, -50, itWidth / 2, 50);
    badge.addColorStop(0, '#6c47ff');
    badge.addColorStop(1, '#ff4f8b');
    ctx.fillStyle = badge;
    roundedRect(ctx, -itWidth / 2, -54, itWidth, 108, 26);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('IT', 0, 4);
    ctx.restore();

    // Puzzle and level
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a49dc6';
    ctx.font = `700 38px ${IMAGE_FONT}`;
    ctx.fillText(state.mode === 'daily' ? `#${state.day + 1} · ${level.day}` : 'Practice round', S / 2, 205);

    ctx.font = `800 34px ${IMAGE_FONT}`;
    const levelText = `Level ${state.level} · ${level.name}`;
    const pipW = 30, pipH = 14, pipGap = 7;
    const pipsWidth = LEVELS.length * pipW + (LEVELS.length - 1) * pipGap;
    const levelWidth = pipsWidth + 20 + ctx.measureText(levelText).width;
    let x = (S - levelWidth) / 2;
    for (let i = 0; i < LEVELS.length; i++) {
      ctx.fillStyle = i < state.level ? PIP_COLOURS[i] : '#3a3462';
      roundedRect(ctx, x, 262 - pipH / 2, pipW, pipH, 7);
      ctx.fill();
      x += pipW + pipGap;
    }
    ctx.fillStyle = '#f3f0ff';
    ctx.textAlign = 'left';
    ctx.fillText(levelText, x + 20 - pipGap, 264);

    // The coloured grid, one row per guess
    const gridTop = 320, gridBottom = 860, gap = 14;
    const rowCount = state.guesses.length;
    const tile = Math.min(110, (gridBottom - gridTop - gap * (rowCount - 1)) / rowCount);
    const gridWidth = WORD_LENGTH * tile + (WORD_LENGTH - 1) * gap;
    const gridHeight = rowCount * tile + (rowCount - 1) * gap;
    const startX = (S - gridWidth) / 2;
    const startY = gridTop + (gridBottom - gridTop - gridHeight) / 2;
    state.guesses.forEach((guess, r) => {
      scoreGuess(guess, state.answer).forEach((result, c) => {
        const tx = startX + c * (tile + gap);
        const ty = startY + r * (tile + gap);
        ctx.fillStyle = IMAGE_COLOURS[result];
        roundedRect(ctx, tx, ty, tile, tile, tile * 0.2);
        ctx.fill();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
        roundedRect(ctx, tx, ty + tile - tile * 0.2, tile, tile * 0.2, tile * 0.1);
        ctx.save();
        roundedRect(ctx, tx, ty, tile, tile, tile * 0.2);
        ctx.clip();
        ctx.fillRect(tx, ty + tile - 7, tile, 7);
        ctx.restore();
      });
    });

    // Score and link
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 56px ${IMAGE_FONT}`;
    ctx.fillText(state.status === 'won'
      ? `Solved in ${state.guesses.length}/${state.maxGuesses}`
      : `X/${state.maxGuesses} · Not this time`, S / 2, 935);
    ctx.fillStyle = '#a49dc6';
    ctx.font = `700 30px ${IMAGE_FONT}`;
    ctx.fillText(location.host + location.pathname.replace(/index\.html$/, '').replace(/\/$/, ''), S / 2, 1010);

    return canvas;
  }

  // Draw the picture as soon as the game ends, so the Share button can use it straight away
  // (phones only open the share menu if it happens immediately after the tap).
  function prepareShareImage() {
    const canvas = drawResultImage();
    const blob = new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No image'))), 'image/png'));
    const prepared = { blob, file: null };
    blob.then((b) => { prepared.file = new File([b], 'guessit-result.png', { type: 'image/png' }); }, () => {});
    shareImage = prepared;
  }

  // Phones and tablets get the system share menu; computers get the picture on the clipboard.
  // (Some computer browsers also offer a share menu, but copying is what players expect there.)
  const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;

  function share() {
    if (!shareImage) prepareShareImage();
    const { blob, file } = shareImage;

    if (isTouchDevice && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], text: shareCaption() }).catch((error) => {
        if (error.name !== 'AbortError') showSharePreview(blob, 'Press and hold the picture below to save or share it.');
      });
      return;
    }
    copyImage(blob);
  }

  function copyImage(blob) {
    const blocked = 'Your browser did not allow copying. Right-click the picture below and choose Copy Image.';
    if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
      showSharePreview(blob, blocked);
      return;
    }
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => showToast('Picture copied. Paste it, then add the link with Copy link', 3200))
      .catch(() => showSharePreview(blob, blocked));
  }

  // Fallback when the picture cannot be shared or copied automatically: show it so the player can copy it by hand.
  function showSharePreview(blob, message) {
    blob.then((b) => {
      // Created here rather than in the page, so a cached older page still works with this script.
      let fallback = document.getElementById('share-fallback');
      if (!fallback) {
        fallback = document.createElement('div');
        fallback.id = 'share-fallback';
        const text = document.createElement('p');
        const image = document.createElement('img');
        image.alt = 'Picture of your result';
        fallback.append(text, image);
        statsDialog.append(fallback);
      }
      const [text, image] = fallback.children;
      if (image.src) URL.revokeObjectURL(image.src);
      image.src = URL.createObjectURL(b);
      text.textContent = message;
      fallback.hidden = false;
    }, () => showToast('Could not create the picture'));
  }

  // ---- Past puzzles (calendar) ------------------------------------------------------

  const archive = document.getElementById('archive');
  const calendar = document.getElementById('calendar');
  let shownMonth; // { year, month } of the calendar page on screen

  function dateOfDay(day) {
    return new Date(FIRST_DAY + day * 86400000);
  }

  function formatDate(day, options) {
    return dateOfDay(day).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
  }

  function openArchive() {
    const date = dateOfDay(state.mode === 'daily' ? state.day : dayNumber());
    shownMonth = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
    renderArchive();
    archive.hidden = false;
    document.body.classList.add('archive-open');
    archive.scrollTop = 0;
    document.getElementById('archive-back').focus();
    // So the phone's back gesture closes the calendar instead of leaving the game.
    if (location.hash !== '#archive') history.pushState(null, '', '#archive');
  }

  // Closing goes "back" in the browser history, which removes #archive and triggers popstate below.
  function closeArchive() {
    if (archive.hidden) return;
    if (location.hash === '#archive') history.back();
    else hideArchive();
  }

  function hideArchive() {
    archive.hidden = true;
    document.body.classList.remove('archive-open');
  }

  function changeMonth(step) {
    const next = new Date(Date.UTC(shownMonth.year, shownMonth.month + step, 1));
    shownMonth = { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    renderArchive();
  }

  function renderArchive() {
    const today = dayNumber();
    const progress = loadProgress();
    const resultOf = (day) => {
      const guesses = savedGuesses(day, progress);
      if (!guesses.length) return { status: 'new', guesses };
      return { status: statusOf(guesses, answerForDay(day), LEVELS[levelOfDay(day) - 1].guesses), guesses };
    };

    // Summary across every puzzle so far
    let solved = 0, missed = 0;
    for (let day = 0; day <= today; day++) {
      const { status } = resultOf(day);
      if (status === 'won') solved++;
      if (status === 'lost') missed++;
    }
    const total = today + 1;
    document.getElementById('archive-summary').textContent =
      `${total} ${total === 1 ? 'puzzle' : 'puzzles'} so far · ${solved} solved · ${missed} missed`;

    // Month heading and arrows (from the month of puzzle #1 to this month)
    const first = dateOfDay(0), last = dateOfDay(today);
    const monthIndex = (y, m) => y * 12 + m;
    const shown = monthIndex(shownMonth.year, shownMonth.month);
    document.getElementById('month-label').textContent =
      new Date(Date.UTC(shownMonth.year, shownMonth.month, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    document.getElementById('month-prev').disabled = shown <= monthIndex(first.getUTCFullYear(), first.getUTCMonth());
    document.getElementById('month-next').disabled = shown >= monthIndex(last.getUTCFullYear(), last.getUTCMonth());

    // Weekday headings, each with its level colour (Monday = level 1 ... Sunday = level 7)
    const cells = LEVELS.map((level, i) => {
      const head = document.createElement('div');
      head.className = `weekday lv${i + 1}`;
      head.textContent = level.day.slice(0, 1);
      head.title = `${level.day}: level ${i + 1}, ${level.name}`;
      return head;
    });

    // Blank cells before the 1st, so the 1st lands under its weekday
    const firstOfMonth = new Date(Date.UTC(shownMonth.year, shownMonth.month, 1));
    const offset = (firstOfMonth.getUTCDay() + 6) % 7;
    for (let i = 0; i < offset; i++) cells.push(document.createElement('div'));

    const daysInMonth = new Date(Date.UTC(shownMonth.year, shownMonth.month + 1, 0)).getUTCDate();
    for (let date = 1; date <= daysInMonth; date++) {
      const day = Math.round((Date.UTC(shownMonth.year, shownMonth.month, date) - FIRST_DAY) / 86400000);
      if (day < 0 || day > today) {
        const locked = document.createElement('div');
        locked.className = 'cal-day locked';
        locked.textContent = date;
        locked.setAttribute('aria-hidden', 'true');
        cells.push(locked);
        continue;
      }
      const level = levelOfDay(day);
      const { status, guesses } = resultOf(day);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `cal-day lv${level} ${status}` + (day === today ? ' today' : '') +
        (state.mode === 'daily' && state.day === day ? ' current' : '');
      const number = document.createElement('span');
      number.className = 'cal-date';
      number.textContent = date;
      const mark = document.createElement('span');
      mark.className = 'cal-mark';
      mark.textContent = status === 'won' ? `${guesses.length}/${LEVELS[level - 1].guesses}`
        : status === 'lost' ? '✗' : status === 'playing' ? '•••' : '';
      cell.append(number, mark);
      const what = { won: `solved in ${guesses.length}`, lost: 'missed', playing: 'started', new: 'not played' }[status];
      cell.setAttribute('aria-label',
        `Puzzle ${day + 1}, ${formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}, level ${level}, ${what}${day === today ? ', today' : ''}`);
      cell.addEventListener('click', () => {
        startDay(day);
        closeArchive();
      });
      cells.push(cell);
    }
    calendar.replaceChildren(...cells);
  }

  // ---- Wiring ---------------------------------------------------------------------

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (helpDialog.open || statsDialog.open || !archive.hidden) return;
    if (event.key === 'Enter') press('enter');
    else if (event.key === 'Backspace') press('back');
    else if (/^[a-zA-Z]$/.test(event.key)) press(event.key.toLowerCase());
  });

  document.getElementById('help-button').addEventListener('click', () => helpDialog.showModal());
  document.getElementById('archive-button').addEventListener('click', () => { if (!busy) openArchive(); });
  document.getElementById('archive-back').addEventListener('click', closeArchive);
  document.getElementById('month-prev').addEventListener('click', () => changeMonth(-1));
  document.getElementById('month-next').addEventListener('click', () => changeMonth(1));
  window.addEventListener('popstate', () => {
    if (location.hash === '#archive') { renderArchive(); archive.hidden = false; document.body.classList.add('archive-open'); }
    else hideArchive();
  });
  archive.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeArchive(); });
  document.getElementById('stats-button').addEventListener('click', openStats);
  document.getElementById('share-button').addEventListener('click', share);
  document.getElementById('link-button').addEventListener('click', copyLink);
  statsDialog.addEventListener('close', () => clearInterval(countdownTimer));

  for (const dialog of [helpDialog, statsDialog]) {
    dialog.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => dialog.close()));
    // A click on the dimmed area outside the panel closes the dialog.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // Load a new daily puzzle if the page was left open past midnight.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !busy && state.isToday && state.day !== dayNumber()) startDaily();
  });

  buildKeyboard();
  startDaily();
  if (location.hash === '#archive') {
    history.replaceState(null, '', location.pathname + location.search);
    openArchive();
  }

  // Show the rules to new players, and once more to returning players since the rules changed.
  if (!store.get('seen-help-v2', false)) {
    store.set('seen-help-v2', true);
    helpDialog.showModal();
  }
})();
