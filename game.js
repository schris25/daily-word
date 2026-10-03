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

  function startDaily() {
    const day = dayNumber();
    const answer = answerForDay(day);
    const saved = store.get('daily', null);
    let guesses = [];
    if (saved && saved.day === day) {
      if (saved.answer === answer) {
        guesses = saved.guesses;
      } else if (saved.guesses.length) {
        // Progress from before the word lists changed: today's word is now different,
        // so start again but do not count today in the statistics twice.
        const stats = loadStats();
        stats.lastPlayedDay = day;
        store.set('stats', stats);
      }
    }
    state = newState('daily', day, levelOfDay(day), answer, guesses);
    buildBoard();
    render();
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
      store.set('daily', { day: state.day, answer: state.answer, guesses: state.guesses });
      if (state.status !== 'playing') recordDailyResult();
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
    subtitle.textContent = state.mode === 'daily' ? `#${state.day + 1} · ${level.day}` : 'Practice round';
    renderLevelBar(level);
    modeBar.replaceChildren();
    if (state.mode === 'daily') {
      modeBar.append(modeButton('Practice round', startPractice));
    } else {
      modeBar.append(modeButton('New word', startPractice), modeButton("Back to today's puzzle", startDaily));
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
    const label = state.mode === 'daily' ? "today's word" : 'the practice word';
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
    const highlight = state.mode === 'daily' && state.status === 'won' ? state.guesses.length - 1 : -1;
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

  function shareText() {
    const squares = { correct: '🟩', present: '🟧', absent: '⬛' };
    const title = state.mode === 'daily'
      ? `${GAME_NAME} #${state.day + 1} · Level ${state.level}/${LEVELS.length}`
      : `${GAME_NAME} practice · Level ${state.level}/${LEVELS.length}`;
    const score = state.status === 'won' ? state.guesses.length : 'X';
    const grid = state.guesses
      .map((guess) => scoreGuess(guess, state.answer).map((result) => squares[result]).join(''))
      .join('\n');
    return `${title} · ${score}/${state.maxGuesses}\n${grid}\n${location.href.split('#')[0]}`;
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(shareText());
      showToast('Result copied');
    } catch {
      showToast('Could not copy the result');
    }
  }

  // ---- Wiring ---------------------------------------------------------------------

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (helpDialog.open || statsDialog.open) return;
    if (event.key === 'Enter') press('enter');
    else if (event.key === 'Backspace') press('back');
    else if (/^[a-zA-Z]$/.test(event.key)) press(event.key.toLowerCase());
  });

  document.getElementById('help-button').addEventListener('click', () => helpDialog.showModal());
  document.getElementById('stats-button').addEventListener('click', openStats);
  document.getElementById('share-button').addEventListener('click', share);
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
    if (!document.hidden && !busy && state.mode === 'daily' && state.day !== dayNumber()) startDaily();
  });

  buildKeyboard();
  startDaily();

  // Show the rules to new players, and once more to returning players since the rules changed.
  if (!store.get('seen-help-v2', false)) {
    store.set('seen-help-v2', true);
    helpDialog.showModal();
  }
})();
