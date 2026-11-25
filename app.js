(() => {
  'use strict';

  // =========================================================================
  // DOM References
  // =========================================================================
  const canvas = document.getElementById('raceCanvas');
  const ctx = canvas.getContext('2d', { alpha: false });

  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const recordBtn = document.getElementById('recordBtn');
  const thumbBtn = document.getElementById('thumbBtn');
  const muteBtn = document.getElementById('muteBtn');
  const muteIcon = document.getElementById('muteIcon');
  const muteLabel = document.getElementById('muteLabel');

  const recBadge = document.getElementById('recBadge');
  const recTimerEl = document.getElementById('recTimer');

  const leftCountInput = document.getElementById('leftCountInput');
  const rightStartInput = document.getElementById('rightStartInput');
  const multGroup = document.getElementById('multGroup');
  const multValueEl = document.getElementById('multValue');
  const speedGroup = document.getElementById('speedGroup');
  const speedValueEl = document.getElementById('speedValue');
  const floorsRange = document.getElementById('floorsRange');
  const floorsValueEl = document.getElementById('floorsValue');
  const durationRange = document.getElementById('durationRange');
  const durationValueEl = document.getElementById('durationValue');
  const leftColorInput = document.getElementById('leftColorInput');
  const leftColorHex = document.getElementById('leftColorHex');
  const rightColorInput = document.getElementById('rightColorInput');
  const rightColorHex = document.getElementById('rightColorHex');

  // =========================================================================
  // Constants & Layout (1080 x 1920)
  // =========================================================================
  const W = 1080;
  const H = 1920;
  const MAX_LEFT_VISUAL_BALLS = 700;
  const MAX_RIGHT_VISUAL_BALLS = 1300; // 700 + 1300 = 2000 max visible balls
  const FREEZE_DURATION = 3.0; // seconds at finish

  const TOWER_L = { x: 72, y: 440, w: 438, h: 1120 };
  const TOWER_R = { x: 570, y: 440, w: 438, h: 1120 };

  // =========================================================================
  // Configuration & Simulation State
  // =========================================================================
  const config = {
    leftCount: 1000000,
    rightStart: 1,
    multiplier: 2,
    floors: 30,
    duration: 50,
    speed: 1,
    leftColor: '#FFD60A',
    rightColor: '#FF7A00',
    muted: false,
  };

  const sim = {
    status: 'idle', // 'idle' | 'running' | 'paused' | 'freezing' | 'done'
    elapsed: 0,
    freezeElapsed: 0,
    lastFrameTime: 0,
    leftProgress: 0,
    rightProgress: 0,
    leftFloor: 1,
    rightFloor: 1,
    prevRightFloor: 1,
    leader: 'left', // 'left' | 'right'
    overtaken: false,
    leftFlash: 0,
    rightFlash: 0,
    overtakeFlash: 0,
    leftBalls: [],
    rightBalls: [],
    externalStepping: false,
  };

  // =========================================================================
  // WebAudio Synthesizer (No external audio files)
  // =========================================================================
  let audioCtx = null;

  function ensureAudio() {
    if (config.muted) return null;
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playDoubleTick(floor, totalFloors) {
    if (config.muted || sim.externalStepping) return;
    const ac = ensureAudio();
    if (!ac) return;

    const now = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();

    const ratio = Math.min(1, Math.max(0, (floor - 1) / Math.max(1, totalFloors - 1)));
    const baseFreq = 260 + ratio * 660;

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.45, now + 0.055);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.14, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.085);

    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  function playOvertakeSound() {
    if (config.muted || sim.externalStepping) return;
    const ac = ensureAudio();
    if (!ac) return;

    const now = ac.currentTime;
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const start = now + idx * 0.045;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  }

  function playWinSound() {
    if (config.muted || sim.externalStepping) return;
    const ac = ensureAudio();
    if (!ac) return;

    const now = ac.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, idx) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const start = now + idx * 0.07;
      osc.type = idx === notes.length - 1 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.16, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.58);
    });
  }

  // =========================================================================
  // Formatting & Math Helpers
  // =========================================================================
  function formatBigInt(val) {
    return val.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatNumber(num) {
    return Math.round(num).toLocaleString('en-US');
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3
      ? clean.split('').map((c) => c + c).join('')
      : clean;
    const num = parseInt(full, 16);
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getRightBallCount(floor) {
    const start = BigInt(Math.max(1, Math.floor(config.rightStart)));
    const mult = BigInt(config.multiplier);
    const exp = BigInt(Math.max(0, floor - 1));
    return start * (mult ** exp);
  }

  function getLeftBallCount() {
    return BigInt(Math.max(1, Math.floor(config.leftCount)));
  }

  function computeLeftProgress(u, N) {
    if (u <= 0) return 0;
    if (u >= 1) return (N - 1) + 0.93;
    if (u <= 0.85) {
      return (N - 1) * (u / 0.85);
    }
    return (N - 1) + 0.93 * ((u - 0.85) / 0.15);
  }

  function computeRightProgress(u, N) {
    if (u <= 0) return 0;
    if (u >= 1) return N;

    const targetAt85 = Math.max(1.5, Math.min(N - 2, N * 0.28));
    const pLeftAt97 = (N - 1) + 0.93 * (0.12 / 0.15);
    const multBoost = config.multiplier === 5 ? 2.1 : config.multiplier === 3 ? 1.8 : 1.55;

    if (u <= 0.85) {
      const v = u / 0.85;
      return targetAt85 * (0.30 * v + 0.70 * Math.pow(v, 2.35));
    }
    if (u <= 0.97) {
      const w = (u - 0.85) / 0.12;
      return targetAt85 + (pLeftAt97 - targetAt85) * Math.pow(w, multBoost);
    }
    const z = (u - 0.97) / 0.03;
    return pLeftAt97 + (N - pLeftAt97) * z;
  }

  // =========================================================================
  // Particle Pool (Capped <= 2000 total) with Smooth Falling Physics
  // =========================================================================
  function createBall(tower, yMin, yMax, radiusScale = 1) {
    const pad = 18;
    const x = tower.x + pad + Math.random() * (tower.w - pad * 2);
    const y = yMin + Math.random() * Math.max(8, yMax - yMin);
    return {
      x,
      y,
      vx: (Math.random() - 0.5) * 165,
      vy: 40 + Math.random() * 140,
      r: (4.5 + Math.random() * 4.2) * radiusScale,
    };
  }

  function syncVisualBalls(dt) {
    const N = config.floors;
    const floorH_L = TOWER_L.h / N;
    const floorH_R = TOWER_R.h / N;

    // Left tower: thousands represented by steady stream of 700 yellow balls
    const leftTarget = Math.min(MAX_LEFT_VISUAL_BALLS, Math.max(1, config.leftCount));
    const leftBandTop = TOWER_L.y + Math.max(0, (sim.leftProgress - 1.4)) * floorH_L;
    const leftBandBot = TOWER_L.y + Math.min(N, sim.leftProgress + 0.2) * floorH_L;

    while (sim.leftBalls.length < leftTarget) {
      sim.leftBalls.push(createBall(TOWER_L, leftBandTop, Math.max(leftBandTop + 32, leftBandBot), 0.95));
    }
    if (sim.leftBalls.length > leftTarget) {
      sim.leftBalls.length = leftTarget;
    }

    // Right tower: starts with 1 single orange ball, multiplies x2 each floor
    const trueRight = getRightBallCount(sim.rightFloor);
    const rightTarget = trueRight > BigInt(MAX_RIGHT_VISUAL_BALLS)
      ? MAX_RIGHT_VISUAL_BALLS
      : Number(trueRight);

    const rightBandTop = TOWER_R.y + Math.max(0, (sim.rightProgress - 1.4)) * floorH_R;
    const rightBandBot = TOWER_R.y + Math.min(N, sim.rightProgress + 0.2) * floorH_R;
    const rScale = rightTarget <= 8 ? 1.85 : rightTarget <= 32 ? 1.35 : 1.0;

    while (sim.rightBalls.length < rightTarget) {
      const parent = sim.rightBalls.length > 0
        ? sim.rightBalls[Math.floor(Math.random() * sim.rightBalls.length)]
        : null;
      const b = createBall(TOWER_R, rightBandTop, Math.max(rightBandTop + 32, rightBandBot), rScale);
      if (parent) {
        b.x = clamp(parent.x + (Math.random() - 0.5) * 28, TOWER_R.x + 18, TOWER_R.x + TOWER_R.w - 18);
        b.y = clamp(parent.y + (Math.random() - 0.5) * 18, TOWER_R.y + 12, TOWER_R.y + TOWER_R.h - 12);
        b.vx = (Math.random() - 0.5) * 220;
        b.vy = 60 + Math.random() * 140;
      }
      sim.rightBalls.push(b);
    }
    if (sim.rightBalls.length > rightTarget) {
      sim.rightBalls.length = rightTarget;
    }
    for (let i = 0; i < sim.rightBalls.length; i++) {
      const targetR = (4.5 + (i % 5) * 0.85) * rScale;
      sim.rightBalls[i].r += (targetR - sim.rightBalls[i].r) * 0.2;
    }

    // Smooth slow-motion gravity + bounce physics
    if (sim.status === 'running' || sim.status === 'idle') {
      const step = Math.min(0.05, dt || 0.016);
      updateTowerParticles(sim.leftBalls, TOWER_L, leftBandTop, Math.max(leftBandTop + 38, leftBandBot), step);
      updateTowerParticles(sim.rightBalls, TOWER_R, rightBandTop, Math.max(rightBandTop + 38, rightBandBot), step);
    }
  }

  function updateTowerParticles(balls, tower, yMin, yMax, dt) {
    const minX = tower.x + 12;
    const maxX = tower.x + tower.w - 12;
    const minY = Math.max(tower.y + 10, yMin);
    const maxY = Math.min(tower.y + tower.h - 10, yMax);
    const gravity = 460;

    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      b.vy += gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x - b.r < minX) {
        b.x = minX + b.r;
        b.vx = Math.abs(b.vx) * 0.92;
      } else if (b.x + b.r > maxX) {
        b.x = maxX - b.r;
        b.vx = -Math.abs(b.vx) * 0.92;
      }

      if (b.y - b.r < minY) {
        b.y = minY + b.r;
        b.vy = Math.abs(b.vy) * 0.65 + 25;
      } else if (b.y + b.r > maxY) {
        b.y = maxY - b.r;
        b.vy = -Math.abs(b.vy) * 0.72 - 20;
      }
    }
  }

  // =========================================================================
  // Simulation Control
  // =========================================================================
  function readInputsToConfig() {
    const lCount = parseInt(leftCountInput.value, 10);
    const rStart = parseInt(rightStartInput.value, 10);
    config.leftCount = Number.isFinite(lCount) && lCount >= 1 ? lCount : 1000000;
    config.rightStart = Number.isFinite(rStart) && rStart >= 1 ? rStart : 1;
    config.floors = parseInt(floorsRange.value, 10) || 30;
    config.duration = parseInt(durationRange.value, 10) || 50;
    config.leftColor = leftColorInput.value || '#FFD60A';
    config.rightColor = rightColorInput.value || '#FF7A00';
  }

  function resetSimulation(autoPlay = false) {
    readInputsToConfig();
    sim.status = autoPlay ? 'running' : 'idle';
    sim.elapsed = 0;
    sim.freezeElapsed = 0;
    sim.lastFrameTime = performance.now();
    sim.leftProgress = 0;
    sim.rightProgress = 0;
    sim.leftFloor = 1;
    sim.rightFloor = 1;
    sim.prevRightFloor = 1;
    sim.leader = 'left';
    sim.overtaken = false;
    sim.leftFlash = 0;
    sim.rightFlash = 0;
    sim.overtakeFlash = 0;
    sim.leftBalls = [];
    sim.rightBalls = [];
    syncVisualBalls(0.016);
    updateActionButtons();
  }

  function updateActionButtons() {
    if (sim.status === 'running') {
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      playBtn.textContent = '▶ Playing';
    } else if (sim.status === 'paused') {
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      playBtn.textContent = '▶ Resume';
    } else {
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      playBtn.textContent = '▶ Play';
    }
  }

  // =========================================================================
  // Canvas Rendering (1080 x 1920) — Pure Black + Transparent Neon Towers
  // =========================================================================
  function drawWrappedText(text, x, y, maxWidth, lineHeight) {
    const words = text.split(' ');
    const lines = [];
    let current = '';

    for (let i = 0; i < words.length; i++) {
      const test = current ? `${current} ${words[i]}` : words[i];
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = words[i];
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }
    return lines.length;
  }

  function drawRoundedRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function getTitleString() {
    const leftStr = formatNumber(config.leftCount);
    const rightStr = formatNumber(config.rightStart);
    const ballWord = config.rightStart === 1 ? 'BALL' : 'BALLS';
    let verb = 'DOUBLES';
    if (config.multiplier === 3) verb = 'TRIPLES';
    else if (config.multiplier === 5) verb = '5X MULTIPLIES';

    return `${leftStr} BALLS OR ${rightStr} ${ballWord} THAT ${verb} EVERY FLOOR`;
  }

  function render() {
    // 1. Pure black background
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);

    // Subtle ambient neon rim glow behind transparent towers
    const gradL = ctx.createRadialGradient(
      TOWER_L.x + TOWER_L.w / 2,
      TOWER_L.y + TOWER_L.h * 0.5,
      40,
      TOWER_L.x + TOWER_L.w / 2,
      TOWER_L.y + TOWER_L.h * 0.5,
      520
    );
    gradL.addColorStop(0, hexToRgba(config.leftColor, 0.08));
    gradL.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradL;
    ctx.fillRect(0, 260, W / 2 + 40, 1450);

    const gradR = ctx.createRadialGradient(
      TOWER_R.x + TOWER_R.w / 2,
      TOWER_R.y + TOWER_R.h * 0.5,
      40,
      TOWER_R.x + TOWER_R.w / 2,
      TOWER_R.y + TOWER_R.h * 0.5,
      520
    );
    gradR.addColorStop(0, hexToRgba(config.rightColor, 0.10));
    gradR.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradR;
    ctx.fillRect(W / 2 - 40, 260, W / 2 + 40, 1450);

    // 2. Top Title Text
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '800 46px "Inter", sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.shadowColor = 'rgba(255, 255, 255, 0.25)';
    ctx.shadowBlur = 16;
    drawWrappedText(getTitleString(), W / 2, 64, W - 120, 58);
    ctx.restore();

    // 3. Tower Headers & Leader / 1ST Badge
    drawTowerHeader(
      TOWER_L,
      formatNumber(config.leftCount),
      'NEVER CHANGES',
      config.leftColor,
      sim.leader === 'left' && sim.status !== 'freezing' && sim.status !== 'done',
      false
    );

    const isFinished = sim.status === 'freezing' || sim.status === 'done';
    drawTowerHeader(
      TOWER_R,
      formatNumber(config.rightStart),
      `x${config.multiplier} EACH FLOOR`,
      config.rightColor,
      sim.leader === 'right' && !isFinished,
      isFinished
    );

    // 4. Transparent Neon Towers & Balls
    drawTower(TOWER_L, sim.leftProgress, sim.leftFloor, config.leftColor, sim.leftBalls, sim.leftFlash);
    drawTower(TOWER_R, sim.rightProgress, sim.rightFloor, config.rightColor, sim.rightBalls, sim.rightFlash);

    // 5. Live Counters & Progress Bars Under Each Tower
    const leftPct = clamp(sim.leftProgress / config.floors, 0, 1);
    const rightPct = clamp(sim.rightProgress / config.floors, 0, 1);

    drawTowerFooter(
      TOWER_L,
      sim.leftFloor,
      config.floors,
      formatBigInt(getLeftBallCount()),
      leftPct,
      config.leftColor
    );

    drawTowerFooter(
      TOWER_R,
      sim.rightFloor,
      config.floors,
      formatBigInt(getRightBallCount(sim.rightFloor)),
      rightPct,
      config.rightColor
    );

    // 6. Finish Freeze Overlay (3 seconds at end)
    if (isFinished) {
      drawFinishOverlay();
    }
  }

  function drawTowerHeader(tower, bigLabel, subLabel, color, showLeader, showFirst) {
    const cx = tower.x + tower.w / 2;

    if (showFirst) {
      drawBadge(cx, 254, '🏆 1ST', '#FFD60A', '#000000', true);
    } else if (showLeader) {
      drawBadge(cx, 254, 'LEADER', color, '#000000', false);
    }

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    ctx.font = '800 56px "Chakra Petch", "Inter", sans-serif';
    ctx.fillStyle = color;
    ctx.shadowColor = hexToRgba(color, 0.55);
    ctx.shadowBlur = 18;
    ctx.fillText(bigLabel, cx, 306);

    ctx.shadowBlur = 0;
    ctx.font = '700 24px "JetBrains Mono", monospace';
    ctx.fillStyle = '#E2E8F0';
    ctx.fillText(subLabel, cx, 374);
    ctx.restore();
  }

  function drawBadge(cx, y, text, bgColor, textColor, isGold) {
    ctx.save();
    ctx.font = '800 22px "JetBrains Mono", monospace';
    const textW = ctx.measureText(text).width;
    const bw = textW + 36;
    const bh = 38;
    const bx = cx - bw / 2;

    ctx.shadowColor = hexToRgba(bgColor, isGold ? 0.9 : 0.65);
    ctx.shadowBlur = 18;
    ctx.fillStyle = bgColor;
    drawRoundedRect(bx, y, bw, bh, 19);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, y + bh / 2 + 1);
    ctx.restore();
  }

  function drawTower(tower, progress, currentFloor, color, balls, flash) {
    const N = config.floors;
    const floorH = tower.h / N;

    ctx.save();
    // Transparent glass tower shell
    drawRoundedRect(tower.x, tower.y, tower.w, tower.h, 22);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.025)';
    ctx.fill();

    ctx.lineWidth = 3;
    ctx.strokeStyle = flash > 0.05
      ? hexToRgba(color, 0.95)
      : hexToRgba(color, 0.48);
    ctx.shadowColor = hexToRgba(color, 0.35);
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Clip inside tower
    ctx.clip();

    // Subtle glass reflection highlight on left edge
    const glassGrad = ctx.createLinearGradient(tower.x, 0, tower.x + 56, 0);
    glassGrad.addColorStop(0, 'rgba(255, 255, 255, 0.07)');
    glassGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = glassGrad;
    ctx.fillRect(tower.x, tower.y, 56, tower.h);

    // Active floor highlight band
    const activeTop = tower.y + (currentFloor - 1) * floorH;
    ctx.fillStyle = hexToRgba(color, 0.12 + flash * 0.25);
    ctx.fillRect(tower.x, activeTop, tower.w, floorH);

    // Floor platforms with center drop gates
    ctx.font = '700 15px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const gateW = 92;
    const gateLeft = tower.x + (tower.w - gateW) / 2;
    const gateRight = gateLeft + gateW;

    for (let f = 1; f < N; f++) {
      const ly = tower.y + f * floorH;
      const isMajor = f % 5 === 0;
      const passed = f < currentFloor;
      ctx.strokeStyle = passed
        ? hexToRgba(color, isMajor ? 0.36 : 0.18)
        : isMajor
          ? 'rgba(255, 255, 255, 0.22)'
          : 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = isMajor ? 2 : 1.2;

      ctx.beginPath();
      ctx.moveTo(tower.x + 6, ly);
      ctx.lineTo(gateLeft, ly);
      ctx.moveTo(gateRight, ly);
      ctx.lineTo(tower.x + tower.w - 6, ly);
      ctx.stroke();

      if (isMajor) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
        ctx.fillText(`F${f}`, tower.x + 14, ly - floorH / 2);
      }
    }

    // Active progress laser line
    const laserY = tower.y + clamp(progress / N, 0, 1) * tower.h;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(tower.x, laserY);
    ctx.lineTo(tower.x + tower.w, laserY);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Render balls with 3D specular highlight
    ctx.fillStyle = color;
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.52)';
    const step = balls.length > 350 ? 2 : 1;
    for (let i = 0; i < balls.length; i += step) {
      const b = balls[i];
      ctx.beginPath();
      ctx.arc(b.x - b.r * 0.28, b.y - b.r * 0.28, b.r * 0.34, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawTowerFooter(tower, floor, totalFloors, ballCountStr, pct, color) {
    const cx = tower.x + tower.w / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    ctx.font = '800 36px "JetBrains Mono", monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`FLOOR ${floor}/${totalFloors}`, cx, 1578);

    let fontSize = 46;
    ctx.font = `800 ${fontSize}px "JetBrains Mono", monospace`;
    while (ctx.measureText(ballCountStr).width > tower.w - 16 && fontSize > 22) {
      fontSize -= 2;
      ctx.font = `800 ${fontSize}px "JetBrains Mono", monospace`;
    }
    ctx.fillStyle = color;
    ctx.shadowColor = hexToRgba(color, 0.5);
    ctx.shadowBlur = 14;
    ctx.fillText(ballCountStr, cx, 1632);
    ctx.shadowBlur = 0;

    const barY = 1708;
    const barH = 14;
    const barW = tower.w;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    drawRoundedRect(tower.x, barY, barW, barH, 7);
    ctx.fill();

    const fillW = Math.max(barH, barW * pct);
    if (pct > 0.002) {
      ctx.fillStyle = color;
      ctx.shadowColor = hexToRgba(color, 0.75);
      ctx.shadowBlur = 14;
      drawRoundedRect(tower.x, barY, Math.min(barW, fillW), barH, 7);
      ctx.fill();
    }

    ctx.restore();
  }

  function drawFinishOverlay() {
    const rightFinal = formatBigInt(getRightBallCount(config.floors));
    const rightStartStr = formatNumber(config.rightStart);
    const ballWord = config.rightStart === 1 ? 'BALL' : 'BALLS';
    const leftStr = formatNumber(config.leftCount);

    ctx.save();

    const cardW = 420;
    const cardH = 260;
    const cardX = TOWER_R.x + (TOWER_R.w - cardW) / 2;
    const cardY = TOWER_R.y + TOWER_R.h / 2 - cardH / 2 - 40;

    ctx.fillStyle = 'rgba(5, 5, 10, 0.92)';
    ctx.strokeStyle = config.rightColor;
    ctx.lineWidth = 3;
    ctx.shadowColor = hexToRgba(config.rightColor, 0.7);
    ctx.shadowBlur = 28;
    drawRoundedRect(cardX, cardY, cardW, cardH, 22);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    const rcx = cardX + cardW / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const finishedText = `${rightFinal} FINISHED`;
    let fSize = 30;
    ctx.font = `800 ${fSize}px "JetBrains Mono", monospace`;
    while (ctx.measureText(finishedText).width > cardW - 36 && fSize > 18) {
      fSize -= 2;
      ctx.font = `800 ${fSize}px "JetBrains Mono", monospace`;
    }
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(finishedText, rcx, cardY + 34);

    ctx.font = '800 44px "Chakra Petch", "Inter", sans-serif';
    ctx.fillStyle = config.rightColor;
    ctx.fillText(`${rightStartStr} ${ballWord} WINS!`, rcx, cardY + 92);

    ctx.font = '700 28px "Inter", sans-serif';
    ctx.fillStyle = '#E2E8F0';
    ctx.fillText('Multiplication wins!', rcx, cardY + 166);

    const bannerW = W - 144;
    const bannerH = 82;
    const bannerX = 72;
    const bannerY = 1770;

    ctx.fillStyle = 'rgba(10, 10, 16, 0.94)';
    ctx.strokeStyle = hexToRgba(config.leftColor, 0.7);
    ctx.lineWidth = 2;
    drawRoundedRect(bannerX, bannerY, bannerW, bannerH, 16);
    ctx.fill();
    ctx.stroke();

    ctx.font = '700 30px "Inter", sans-serif';
    ctx.fillStyle = config.leftColor;
    ctx.textBaseline = 'middle';
    ctx.fillText(
      `${leftStr} BALLS were 93% through the last floor!`,
      W / 2,
      bannerY + bannerH / 2
    );

    ctx.restore();
  }

  // =========================================================================
  // Deterministic Step & Animation Loop (60fps)
  // =========================================================================
  function stepSimulation(rawDt) {
    if (sim.status === 'running') {
      sim.elapsed += rawDt * config.speed;
      const u = clamp(sim.elapsed / config.duration, 0, 1);

      sim.leftProgress = computeLeftProgress(u, config.floors);
      sim.rightProgress = computeRightProgress(u, config.floors);

      sim.leftFloor = Math.min(config.floors, Math.floor(sim.leftProgress) + 1);
      sim.rightFloor = Math.min(config.floors, Math.floor(sim.rightProgress) + 1);

      if (sim.rightFloor > sim.prevRightFloor) {
        sim.prevRightFloor = sim.rightFloor;
        sim.rightFlash = 1.0;
        playDoubleTick(sim.rightFloor, config.floors);
      }

      const newLeader = sim.rightProgress >= sim.leftProgress ? 'right' : 'left';
      if (newLeader === 'right' && !sim.overtaken) {
        sim.overtaken = true;
        sim.overtakeFlash = 1.0;
        playOvertakeSound();
      }
      sim.leader = newLeader;

      if (u >= 1) {
        sim.status = 'freezing';
        sim.freezeElapsed = 0;
        sim.leader = 'right';
        playWinSound();
        updateActionButtons();
      }
    } else if (sim.status === 'freezing') {
      sim.freezeElapsed += rawDt;
      if (sim.freezeElapsed >= FREEZE_DURATION) {
        sim.status = 'done';
        updateActionButtons();
      }
    }

    sim.leftFlash = Math.max(0, sim.leftFlash - rawDt * 3.5);
    sim.rightFlash = Math.max(0, sim.rightFlash - rawDt * 3.5);
    sim.overtakeFlash = Math.max(0, sim.overtakeFlash - rawDt * 2.5);

    syncVisualBalls(rawDt);
    render();
  }

  function tick(now) {
    if (!sim.externalStepping) {
      const rawDt = Math.min(0.05, Math.max(0.001, (now - sim.lastFrameTime) / 1000));
      sim.lastFrameTime = now;
      stepSimulation(rawDt);
    }
    requestAnimationFrame(tick);
  }

  // Deterministic frame-by-frame hook for offline 60fps export
  window.__ballRaceExportStep = (dt) => {
    sim.externalStepping = true;
    if (sim.status === 'idle') {
      sim.status = 'running';
    }
    stepSimulation(dt);
    return sim.status;
  };

  // =========================================================================
  // MediaRecorder (60fps 1080x1920 .webm) & Thumbnail Export
  // =========================================================================
  let mediaRecorder = null;
  let recordedChunks = [];
  let recTimerInterval = null;
  let recStartTime = 0;

  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const type of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    return '';
  }

  function updateRecTimer() {
    const secs = Math.floor((Date.now() - recStartTime) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    recTimerEl.textContent = `${mm}:${ss}`;
  }

  function startRecording() {
    if (typeof canvas.captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      alert('Your browser does not support canvas.captureStream(60) + MediaRecorder.');
      return;
    }

    const stream = canvas.captureStream(60);
    const mimeType = pickMimeType();
    const options = mimeType
      ? { mimeType, videoBitsPerSecond: 8_000_000 }
      : { videoBitsPerSecond: 8_000_000 };

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        recordedChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ball-race-${config.floors}floors-${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };

    mediaRecorder.start(250);
    recStartTime = Date.now();
    updateRecTimer();
    recTimerInterval = setInterval(updateRecTimer, 500);

    recordBtn.classList.add('recording');
    recordBtn.textContent = '■ Stop Recording';
    recBadge.classList.remove('hidden');
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    clearInterval(recTimerInterval);
    recTimerInterval = null;
    recordBtn.classList.remove('recording');
    recordBtn.textContent = '● Record 60fps';
    recBadge.classList.add('hidden');
  }

  // =========================================================================
  // Event Listeners
  // =========================================================================
  playBtn.addEventListener('click', () => {
    ensureAudio();
    if (sim.status === 'done' || sim.status === 'freezing') {
      resetSimulation(true);
    } else {
      sim.status = 'running';
      sim.lastFrameTime = performance.now();
      updateActionButtons();
    }
  });

  pauseBtn.addEventListener('click', () => {
    if (sim.status === 'running') {
      sim.status = 'paused';
      updateActionButtons();
    }
  });

  restartBtn.addEventListener('click', () => {
    ensureAudio();
    resetSimulation(true);
  });

  recordBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  thumbBtn.addEventListener('click', () => {
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `ball-race-thumbnail-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  muteBtn.addEventListener('click', () => {
    config.muted = !config.muted;
    muteBtn.setAttribute('aria-pressed', String(config.muted));
    muteBtn.classList.toggle('muted', config.muted);
    muteIcon.textContent = config.muted ? '🔇' : '🔊';
    muteLabel.textContent = config.muted ? 'Muted' : 'Sound On';
  });

  speedGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    speedGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    config.speed = parseFloat(btn.dataset.speed) || 1;
    speedValueEl.textContent = `${config.speed}x`;
  });

  multGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    multGroup.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    config.multiplier = parseInt(btn.dataset.mult, 10) || 2;
    multValueEl.textContent = `x${config.multiplier}`;
  });

  floorsRange.addEventListener('input', () => {
    floorsValueEl.textContent = floorsRange.value;
  });

  durationRange.addEventListener('input', () => {
    durationValueEl.textContent = `${durationRange.value}s`;
  });

  leftColorInput.addEventListener('input', () => {
    config.leftColor = leftColorInput.value;
    leftColorHex.textContent = leftColorInput.value.toUpperCase();
  });

  rightColorInput.addEventListener('input', () => {
    config.rightColor = rightColorInput.value;
    rightColorHex.textContent = rightColorInput.value.toUpperCase();
  });

  // =========================================================================
  // Initialize
  // =========================================================================
  resetSimulation(false);
  requestAnimationFrame(tick);
})();
