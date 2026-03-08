const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const scoreElement = document.getElementById('score');
const healthContainer = document.getElementById('health-container');
const overlay = document.getElementById('overlay');
const startOverlay = document.getElementById('start-overlay');
const startBtn = document.getElementById('start-btn');
const vsBtn = document.getElementById('vs-btn');
const titleText = document.getElementById('title-text');
const desc1Text = document.getElementById('desc1-text');
const desc2Text = document.getElementById('desc2-text');
const statusText = document.getElementById('status-text');
const finalScoreElement = document.getElementById('final-score');
const restartBtn = document.getElementById('restart-btn');

canvas.width = 600;
canvas.height = 800;

let score = 0;
let health = 3; 
let gameActive = false;
let keys = {};
let frameCount = 0;
let shakeAmount = 0;
let difficultyMultiplier = 1.0;
let messageTimer = 0;
let messageText = "";

let player;
let bullets = [];
let enemyBullets = [];
let enemies = [];
let particles = [];
let powerUps = [];
let healthPacks = [];
let stars = [];
let enemySpawnCooldown = 0;

let boss = null;
let isBossActive = false;
let nextBossScore = 500;

// --- 對戰連線相關 ---
let isVersus = false;
let socket = null;
let currentRoom = null;

if (typeof io !== 'undefined') {
    socket = io();

    socket.on('waitingForOpponent', () => {
        titleText.textContent = "WAITING...";
        desc1Text.textContent = "SEARCHING FOR OPPONENT";
        desc2Text.textContent = "";
        startBtn.style.display = 'none';
        vsBtn.style.display = 'none';
    });

    socket.on('matchFound', (data) => {
        currentRoom = data.room;
        isVersus = true;
        startGame();
    });

    socket.on('receiveGarbage', (data) => {
        if (gameActive) {
            // 從對手傳來的垃圾敵機，固定從畫面頂端出現，並加上一點發光標記
            const enemy = new Enemy(undefined, -70, data.type);
            enemy.isGarbage = true; // 標記為對手送來的
            enemies.push(enemy);
        }
    });
}

// --- 高級音訊管理器 ---
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;
let bgmBuffer = null;
let currentBgmNodes = [];

async function loadBGM() {
    try {
        const response = await fetch('bgm.mp3');
        if (!response.ok) throw new Error("HTTP error " + response.status);
        const arrayBuffer = await response.arrayBuffer();
        bgmBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error("無法載入 bgm.mp3", e);
        fallbackBGM();
    }
}

let simpleBgm = null;
function fallbackBGM() {
    simpleBgm = new Audio('bgm.mp3');
    simpleBgm.loop = true;
    simpleBgm.volume = 0.2;
    simpleBgm.play();
}

function playBGMNode(time, fadeTime = 2) {
    if (!bgmBuffer || !gameActive) return;
    const source = audioCtx.createBufferSource();
    source.buffer = bgmBuffer;
    const gainNode = audioCtx.createGain();
    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(0.2, time + fadeTime);
    const stopTime = time + bgmBuffer.duration;
    gainNode.gain.setValueAtTime(0.2, stopTime - fadeTime);
    gainNode.gain.linearRampToValueAtTime(0, stopTime);
    source.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    source.start(time);
    source.stop(stopTime);
    const nextStartTime = stopTime - fadeTime;
    const nextTimeout = (nextStartTime - audioCtx.currentTime) * 1000;
    currentBgmNodes.push({ source, gainNode });
    setTimeout(() => { if (gameActive) playBGMNode(nextStartTime, fadeTime); }, Math.max(0, nextTimeout));
}

function stopAllBGM() {
    if (simpleBgm) { simpleBgm.pause(); simpleBgm = null; }
    currentBgmNodes.forEach(node => {
        try {
            node.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            node.gainNode.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + 1);
            node.source.stop(audioCtx.currentTime + 1.1);
        } catch(e) {}
    });
    currentBgmNodes = [];
}

function playSound(freq, type, duration, vol = 0.1, falloff = true) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    if (falloff) osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
}

const SFX = {
    shoot: () => playSound(600, 'square', 0.15, 0.15),
    laser: () => playSound(1800, 'sine', 0.05, 0.2),
    explode: () => { playSound(100, 'sawtooth', 0.4, 0.4); playSound(50, 'triangle', 0.5, 0.5); },
    powerup: () => { [440, 554, 659, 880].forEach((n, i) => setTimeout(() => playSound(n, 'sine', 0.3, 0.15, false), i * 60)); },
    heal: () => { [523, 659, 783, 1046].forEach((n, i) => setTimeout(() => playSound(n, 'triangle', 0.4, 0.15, false), i * 50)); },
    levelUp: () => { [200, 300, 400, 600].forEach((n, i) => setTimeout(() => playSound(n, 'square', 0.5, 0.15, false), i * 100)); }
};

// --- 遊戲邏輯 ---
for(let i=0; i<120; i++) {
    stars.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, size: Math.random() * 3 + 1, speed: Math.random() * 4 + 1, opacity: Math.random() * 0.7 + 0.3 });
}

const playerImgs = { CENTER: new Image(), LEFT: new Image(), RIGHT: new Image() };
playerImgs.CENTER.src = 'player_nobg.png'; playerImgs.LEFT.src = 'player_left.png'; playerImgs.RIGHT.src = 'player_right.png';

const enemyAssetKeys = ['std', 'sniper', 'bomber', 'seeker'];
const enemyImgs = {};
enemyAssetKeys.forEach(key => {
    enemyImgs[key] = { CENTER: new Image(), LEFT: new Image(), RIGHT: new Image() };
    enemyImgs[key].CENTER.src = `enemy_${key}.png`; enemyImgs[key].LEFT.src = `enemy_${key}_left.png`; enemyImgs[key].RIGHT.src = `enemy_${key}_right.png`;
});

const bossImg = new Image(); bossImg.src = 'boss.png';

const WEAPON_TYPES = { NORMAL: 'NORMAL', TRIPLE: 'TRIPLE', SPREAD: 'SPREAD', LASER: 'LASER' };
const ENEMY_TYPES = {
    STANDARD: { asset: 'std', shootChance: 0.01, bulletType: 'NORMAL' },
    SNIPER: { asset: 'sniper', shootChance: 0.005, bulletType: 'FAST' },
    BOMBER: { asset: 'bomber', shootChance: 0.015, bulletType: 'SPREAD' },
    SEEKER: { asset: 'seeker', shootChance: 0.008, bulletType: 'HOMING' }
};

class Player {
    constructor() { this.width = 60; this.height = 60; this.x = canvas.width / 2 - this.width / 2; this.y = canvas.height - 150; this.speed = 7; this.weaponType = WEAPON_TYPES.NORMAL; this.powerUpTimer = 0; this.tilt = 'CENTER'; this.hitShake = 0; this.invincibleTimer = 0; }
    draw() {
        if (this.invincibleTimer > 0 && frameCount % 6 < 3) return;
        const x = Math.round(this.x), y = Math.round(this.y), w = this.width, h = this.height;
        const img = playerImgs[this.tilt];
        if (img.complete && img.naturalWidth !== 0) {
            ctx.save();
            if (this.hitShake > 0) { ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake); }
            const ratio = img.naturalWidth / img.naturalHeight;
            let drawW = w, drawH = h;
            if (this.tilt !== 'CENTER') { drawH = h; drawW = drawH * ratio; }
            const drawX = x + w/2 - drawW/2, drawY = y + h/2 - drawH/2;
            ctx.shadowBlur = 10; ctx.shadowColor = '#38d9a9';
            ctx.drawImage(img, drawX, drawY, drawW, drawH);
            ctx.shadowBlur = 0;
            if (this.powerUpTimer > 0) {
                ctx.globalCompositeOperation = 'source-atop';
                const colors = { TRIPLE: 'rgba(72, 52, 212, 0.5)', SPREAD: 'rgba(106, 176, 76, 0.5)', LASER: 'rgba(190, 46, 221, 0.5)' };
                ctx.fillStyle = colors[this.weaponType];
                ctx.fillRect(drawX, drawY, drawW, drawH);
                ctx.globalCompositeOperation = 'source-over';
            }
            ctx.restore();
        }
        if (frameCount % 4 < 2) { ctx.fillStyle = '#ff9f43'; ctx.fillRect(x + w/2 - 10, y + h - 5, 6, 8); ctx.fillRect(x + w/2 + 4, y + h - 5, 6, 8); }
    }
    update() {
        if (this.hitShake > 0) { this.hitShake *= 0.85; if (this.hitShake < 0.5) this.hitShake = 0; }
        if (this.invincibleTimer > 0) this.invincibleTimer--;
        this.tilt = 'CENTER';
        if (keys['ArrowLeft'] || keys['a']) { this.x -= this.speed; this.tilt = 'LEFT'; }
        if (keys['ArrowRight'] || keys['d']) { this.x += this.speed; this.tilt = 'RIGHT'; }
        if (keys['ArrowUp'] || keys['w']) this.y -= this.speed;
        if (keys['ArrowDown'] || keys['s']) this.y += this.speed;
        this.x = Math.max(0, Math.min(canvas.width - this.width, this.x));
        this.y = Math.max(80, Math.min(canvas.height - this.height - 20, this.y));
        if (this.powerUpTimer > 0) { this.powerUpTimer--; if (this.powerUpTimer <= 0) this.weaponType = WEAPON_TYPES.NORMAL; }
        if (this.weaponType === WEAPON_TYPES.LASER && keys[' '] && gameActive) this.shoot();
    }
    shoot() {
        if (this.weaponType === WEAPON_TYPES.LASER) SFX.laser(); else SFX.shoot();
        const centerX = this.x + this.width / 2, topY = this.y;
        switch(this.weaponType) {
            case WEAPON_TYPES.TRIPLE: bullets.push(new Bullet(centerX, topY), new Bullet(centerX-20, topY+10), new Bullet(centerX+20, topY+10)); break;
            case WEAPON_TYPES.SPREAD: for(let i=-2; i<=2; i++) bullets.push(new Bullet(centerX, topY, i * 1.5)); break;
            case WEAPON_TYPES.LASER: let b = new Bullet(centerX, topY); b.width=10; b.height=50; b.speed=30; b.color='#be2edd'; b.isLaser=true; bullets.push(b); break;
            default: bullets.push(new Bullet(centerX, topY));
        }
    }
    takeDamage() {
        if (this.invincibleTimer > 0) return;
        health--; this.hitShake = 25; this.invincibleTimer = 60; SFX.explode(); updateUI();
        if (health <= 0) { gameActive = false; stopAllBGM(); gameOver(); }
    }
}

class Boss {
    constructor() { this.width = 300; this.height = 300; this.x = (canvas.width - this.width) / 2; this.y = -this.height; this.maxHealth = (150 + (score / 100)) * difficultyMultiplier; this.health = this.maxHealth; this.speedX = 2.5 * difficultyMultiplier; this.targetY = 100; this.state = 'ENTERING'; this.attackTimer = 0; this.hitShake = 0; }
    draw() {
        const x = Math.round(this.x), y = Math.round(this.y);
        ctx.save();
        if (this.hitShake > 0) { ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake); }
        if (this.state === 'BATTLE') { ctx.shadowBlur = 20; ctx.shadowColor = '#ff4757'; }
        if (bossImg.complete) ctx.drawImage(bossImg, x, y, this.width, this.height);
        ctx.restore();
        const barWidth = 450, barHeight = 25, barX = (canvas.width - barWidth) / 2, barY = 45;
        ctx.fillStyle = '#2f3542'; ctx.fillRect(barX, barY, barWidth, barHeight);
        ctx.fillStyle = '#ff4757'; ctx.fillRect(barX, barY, barWidth * (this.health / this.maxHealth), barHeight);
        ctx.strokeStyle = 'white'; ctx.lineWidth = 3; ctx.strokeRect(barX, barY, barWidth, barHeight);
        ctx.fillStyle = 'white'; ctx.font = '12px "Press Start 2P"'; ctx.textAlign = 'center'; ctx.fillText("ULTIMATE UNIT DETECTED", canvas.width / 2, barY + 18);
    }
    update() {
        if (this.hitShake > 0) { this.hitShake *= 0.85; if (this.hitShake < 0.5) this.hitShake = 0; }
        if (this.state === 'ENTERING') { this.y += 1.5; if (this.y >= this.targetY) this.state = 'BATTLE'; }
        else {
            this.x += this.speedX; if (this.x <= 0 || this.x > canvas.width - this.width) this.speedX *= -1;
            this.attackTimer++;
            const fireRate = Math.max(20, 50 - (difficultyMultiplier * 5));
            if (this.attackTimer % Math.floor(fireRate) === 0) { for(let i=0; i<12; i++) { const angle = (i / 12) * Math.PI * 2; enemyBullets.push(new EnemyBullet(this.x + this.width/2, this.y + this.height/2, { vx: Math.cos(angle) * (3 + difficultyMultiplier), speed: Math.sin(angle) * (3 + difficultyMultiplier) + 3, color: '#ff4757', width: 12, height: 12 })); } }
            if (this.attackTimer % 120 === 0) enemyBullets.push(new EnemyBullet(this.x + this.width/2, this.y + this.height, { isHoming: true, speed: 4 + difficultyMultiplier, color: '#be2edd', width: 20, height: 20 }));
        }
    }
}

class Enemy {
    constructor(x, y, forcedType = null, forcedVX = 0, forcedVY = null) {
        const typeKeys = Object.keys(ENEMY_TYPES);
        const typeKey = forcedType || typeKeys[Math.floor(Math.random() * typeKeys.length)];
        const typeCfg = ENEMY_TYPES[typeKey];
        this.type = typeKey; this.width = 70; this.height = 70;
        this.x = (x !== undefined) ? x : Math.random() * (canvas.width - this.width);
        this.y = (y !== undefined) ? y : -this.height;
        this.baseSpeed = ((forcedVY !== null) ? forcedVY : (1 + Math.random() * 2)) * difficultyMultiplier;
        this.speed = this.baseSpeed; this.vx = forcedVX * difficultyMultiplier; this.assetKey = typeCfg.asset; this.shootChance = typeCfg.shootChance * difficultyMultiplier; this.bulletType = typeCfg.bulletType;
        this.aiTimer = 0; this.state = (forcedVX !== 0) ? 'FLY_BY' : 'NORMAL'; this.hitShake = 0;
        this.isGarbage = false; // 標記是否為對手送來的
    }
    draw() {
        const x = Math.round(this.x), y = Math.round(this.y), w = this.width, h = this.height;
        const imgSet = enemyImgs[this.assetKey];
        ctx.save();
        if (this.hitShake > 0) { ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake); }
        ctx.translate(x + w/2, y + h/2);
        
        // 如果是對手送來的垃圾敵機，給它一層紅光警告
        if (this.isGarbage) {
            ctx.shadowBlur = 15;
            ctx.shadowColor = 'red';
        }

        if (this.state === 'FLY_BY') ctx.rotate(this.vx > 0 ? -Math.PI / 2 : Math.PI / 2);
        else { if (this.vx < -0.5) ctx.rotate(0.15); else if (this.vx > 0.5) ctx.rotate(-0.15); }
        const img = imgSet.CENTER;
        if (img.complete && img.naturalWidth !== 0) ctx.drawImage(img, -w/2, -h/2, w, h);
        ctx.restore();
    }
    update() {
        if (this.hitShake > 0) { this.hitShake *= 0.8; if (this.hitShake < 0.5) this.hitShake = 0; }
        if (this.state !== 'FLY_BY') {
            this.aiTimer--;
            if (this.aiTimer <= 0) {
                const rand = Math.random();
                if (rand < 0.6) { this.state = 'NORMAL'; this.vx = 0; this.speed = this.baseSpeed; this.aiTimer = 60 + Math.random() * 60; }
                else if (rand < 0.9) { this.state = 'STRAFE'; this.vx = (Math.random() - 0.5) * 6 * difficultyMultiplier; this.aiTimer = 100 + Math.random() * 100; }
                else { this.state = 'DIVE'; this.vx = 0; this.speed = this.baseSpeed + 5; this.aiTimer = 40; }
            }
        }
        this.y += this.speed; this.x += this.vx;
        if (this.state !== 'FLY_BY' && (this.x < 0 || this.x > canvas.width - this.width)) this.vx *= -1;
        if (gameActive && Math.random() < this.shootChance) this.shoot();
    }
    shoot() {
        const cx = this.x + this.width/2, cy = this.y + this.height;
        switch(this.bulletType) {
            case 'FAST': enemyBullets.push(new EnemyBullet(cx, cy, { speed: 14 * difficultyMultiplier, width: 4, height: 28, color: '#eccc68' })); break;
            case 'SPREAD': [-2.5, 0, 2.5].forEach(vx => enemyBullets.push(new EnemyBullet(cx, cy, { vx: vx * difficultyMultiplier, color: '#7bed9f' }))); break;
            case 'HOMING': enemyBullets.push(new EnemyBullet(cx, cy, { speed: 4 * difficultyMultiplier, isHoming: true, color: '#a29bfe', width: 14, height: 14 })); break;
            default: enemyBullets.push(new EnemyBullet(cx, cy, { speed: 5 * difficultyMultiplier }));
        }
    }
}

class Bullet { constructor(x, y, vx = 0) { this.x = x - 4; this.y = y; this.vx = vx; this.width = 8; this.height = 16; this.speed = 12; this.color = '#fff200'; this.isLaser = false; } draw() { ctx.save(); ctx.shadowBlur = 10; ctx.shadowColor = this.color; ctx.fillStyle = this.color; ctx.fillRect(Math.round(this.x), Math.round(this.y), this.width, this.height); ctx.restore(); } update() { this.y -= this.speed; this.x += this.vx; } }
class EnemyBullet { constructor(x, y, options = {}) { this.x = x; this.y = y; this.width = options.width || 8; this.height = options.height || 8; this.speed = options.speed || 5; this.vx = options.vx || 0; this.color = options.color || '#ff4757'; this.isHoming = options.isHoming || false; } draw() { ctx.save(); ctx.shadowBlur = 8; ctx.shadowColor = this.color; ctx.fillStyle = this.color; ctx.fillRect(Math.round(this.x - this.width/2), Math.round(this.y), this.width, this.height); ctx.restore(); } update() { if (this.isHoming && player) { let dx = (player.x + player.width/2) - this.x; this.vx += Math.sign(dx) * 0.15; this.vx = Math.max(-3, Math.min(3, this.vx)); } this.y += this.speed; this.x += this.vx; } }
class Particle { constructor(x, y, color) { this.x = x; this.y = y; this.size = Math.random() * 8 + 4; this.speedX = (Math.random() - 0.5) * 12; this.speedY = (Math.random() - 0.5) * 12; this.color = color; this.life = 1; } draw() { ctx.globalAlpha = this.life; ctx.fillStyle = this.color; ctx.fillRect(Math.round(this.x), Math.round(this.y), this.size, this.size); ctx.globalAlpha = 1; } update() { this.x += this.speedX; this.y += this.speedY; this.life -= 0.05; } }
class PowerUp { constructor(x, y) { this.width = 32; this.height = 32; this.x = x || Math.random() * (canvas.width - this.width); this.y = y || -this.height; this.speed = 3; const types = [WEAPON_TYPES.TRIPLE, WEAPON_TYPES.SPREAD, WEAPON_TYPES.LASER]; this.type = types[Math.floor(Math.random() * types.length)]; this.color = (this.type === WEAPON_TYPES.TRIPLE) ? '#4834d4' : (this.type === WEAPON_TYPES.SPREAD ? '#6ab04c' : '#be2edd'); } draw() { ctx.save(); ctx.shadowBlur = 10; ctx.shadowColor = this.color; ctx.fillStyle = this.color; ctx.fillRect(Math.round(this.x), Math.round(this.y), 32, 32); ctx.fillStyle = 'white'; ctx.font = '12px "Press Start 2P"'; ctx.textAlign = 'center'; ctx.fillText(this.type[0], this.x + 16, this.y + 22); ctx.restore(); } update() { this.y += this.speed; this.x += Math.sin(this.y / 25) * 3; } }
class HealthPack { constructor(x, y) { this.width = 32; this.height = 32; this.x = x; this.y = y; this.speed = 2.5; } draw() { ctx.save(); ctx.shadowBlur = 10; ctx.shadowColor = '#ff4757'; ctx.fillStyle = '#ff4757'; ctx.fillRect(Math.round(this.x), Math.round(this.y), 32, 32); ctx.fillStyle = 'white'; ctx.fillRect(Math.round(this.x) + 12, Math.round(this.y) + 6, 8, 20); ctx.fillRect(Math.round(this.x) + 6, Math.round(this.y) + 12, 20, 8); ctx.restore(); } update() { this.y += this.speed; this.x += Math.sin(this.y / 30) * 2; } }

function startGame() {
    player = new Player(); bullets = []; enemyBullets = []; enemies = []; particles = []; powerUps = []; healthPacks = []; score = 0; health = 3; gameActive = true; enemySpawnCooldown = 0; isBossActive = false; boss = null; nextBossScore = 500; difficultyMultiplier = 1.0; messageTimer = 0; updateUI(); 
    overlay.classList.add('hidden'); startOverlay.classList.add('hidden');
    if (bgmBuffer) playBGMNode(audioCtx.currentTime, 2); else fallbackBGM();
    animate();
}

function updateUI() { scoreElement.textContent = `SCORE: ${score.toString().padStart(4, '0')}`; healthContainer.innerHTML = ''; for (let i = 0; i < 3; i++) { const heart = document.createElement('span'); heart.className = 'heart'; heart.textContent = i < health ? '❤️' : '🖤'; healthContainer.appendChild(heart); } }

function spawnEnemy() { 
    if (!gameActive || isBossActive) return;
    if (score >= nextBossScore) { isBossActive = true; boss = new Boss(); return; }
    if (enemySpawnCooldown > 0) enemySpawnCooldown--;
    if (enemySpawnCooldown <= 0 && enemies.length < 30) {
        const eventRand = Math.random();
        if (eventRand < 0.08) { const startY = 100 + Math.random() * 300; const type = Object.keys(ENEMY_TYPES)[Math.floor(Math.random() * 4)]; for(let i=0; i<4; i++) enemies.push(new Enemy(-100 - (i * 80), startY, type, 5, 0.2)); enemySpawnCooldown = 120 / difficultyMultiplier; }
        else if (eventRand < 0.16) { const startY = 100 + Math.random() * 300; const type = Object.keys(ENEMY_TYPES)[Math.floor(Math.random() * 4)]; for(let i=0; i<4; i++) enemies.push(new Enemy(canvas.width + 100 + (i * 80), startY, type, -5, 0.2)); enemySpawnCooldown = 120 / difficultyMultiplier; }
        else { enemies.push(new Enemy()); enemySpawnCooldown = Math.max(5, (25 - Math.floor(score / 100)) / difficultyMultiplier); }
    }
}

function spawnPowerUp() { if (gameActive && Math.random() < 0.002) powerUps.push(new PowerUp()); }
function createExplosion(x, y, color, count = 10) { for (let i = 0; i < count; i++) particles.push(new Particle(x, y, color)); }

function checkCollisions() {
    bullets.forEach((bullet, bIndex) => {
        enemies.forEach((enemy, eIndex) => {
            if (bullet.x < enemy.x + enemy.width && bullet.x + bullet.width > enemy.x && bullet.y < enemy.y + enemy.height && bullet.y + bullet.height > enemy.y) {
                enemy.hitShake = 15; 
                setTimeout(() => {
                    createExplosion(enemy.x + enemy.width/2, enemy.y + enemy.height/2, '#ff4757', 15); SFX.explode();
                    if (health < 3 && Math.random() < 0.03) healthPacks.push(new HealthPack(enemy.x + enemy.width/2 - 16, enemy.y + enemy.height/2 - 16));
                    
                    // 【對戰模式】將擊毀的敵機傳送給對手
                    if (isVersus && socket && !enemy.isGarbage) {
                        socket.emit('sendGarbage', { room: currentRoom, type: enemy.type });
                    }
                    enemies.splice(eIndex, 1); 
                }, 50);
                if (!bullet.isLaser) bullets.splice(bIndex, 1);
                score += 10; updateUI();
            }
        });
        if (isBossActive && boss) {
            if (bullet.x < boss.x + boss.width && bullet.x + bullet.width > boss.x && bullet.y < boss.y + boss.height && bullet.y + bullet.height > boss.y) {
                boss.health -= (bullet.isLaser ? 0.5 : 1); boss.hitShake = 10; createExplosion(bullet.x, bullet.y, '#fff200', 3); if (!bullet.isLaser) bullets.splice(bIndex, 1);
                if (boss.health <= 0) { 
                    shakeAmount = 30; SFX.levelUp(); SFX.explode(); createExplosion(boss.x + boss.width/2, boss.y + boss.height/2, '#ff4757', 60); score += 500; if (health < 3) health++; 
                    isBossActive = false; boss = null; nextBossScore += 1000; difficultyMultiplier += 0.2; messageText = "THREAT LEVEL INCREASED!"; messageTimer = 180; updateUI(); 
                }
            }
        }
    });
    enemyBullets.forEach((eb, index) => {
        if (eb.x < player.x + player.width && eb.x + eb.width > player.x && eb.y < player.y + player.height && eb.y + eb.height > player.y) {
            enemyBullets.splice(index, 1); player.takeDamage();
        }
        if (eb.y > canvas.height) enemyBullets.splice(index, 1);
    });
    enemies.forEach((enemy, index) => {
        if (enemy.x < player.x + player.width && enemy.x + enemy.width > player.x && enemy.y < player.y + player.height && enemy.y + enemy.height > player.y) {
            enemies.splice(index, 1); player.takeDamage();
        }
        if (enemy.y > canvas.height + 100 || enemy.x < -200 || enemy.x > canvas.width + 200) { enemies.splice(index, 1); }
    });
    if (isBossActive && boss && boss.x < player.x + player.width && boss.x + boss.width > player.x && boss.y < player.y + player.height && boss.y + boss.height > player.y) { 
        health = 0; updateUI(); gameActive = false; stopAllBGM(); gameOver(); 
    }
    powerUps.forEach((powerUp, index) => {
        if (powerUp.x < player.x + player.width && powerUp.x + powerUp.width > player.x && powerUp.y < player.y + player.height && powerUp.y + powerUp.height > player.y) {
            player.weaponType = powerUp.type; player.powerUpTimer = 480; SFX.powerup(); createExplosion(powerUp.x + 16, powerUp.y + 16, powerUp.color, 20); powerUps.splice(index, 1);
        }
        if (powerUp.y > canvas.height) powerUps.splice(index, 1);
    });
    healthPacks.forEach((hp, index) => {
        if (hp.x < player.x + player.width && hp.x + hp.width > player.x && hp.y < player.y + player.height && hp.y + hp.height > player.y) {
            if (health < 3) { health++; updateUI(); } SFX.heal(); createExplosion(hp.x + 16, hp.y + 16, '#2ecc71', 20); healthPacks.splice(index, 1);
        }
        if (hp.y > canvas.height) healthPacks.splice(index, 1);
    });
}

function gameOver() { finalScoreElement.textContent = score; overlay.classList.remove('hidden'); }

function animate() {
    if (!gameActive) return;
    requestAnimationFrame(animate);
    frameCount++;
    let dx = 0, dy = 0;
    if (shakeAmount > 0) { dx = (Math.random() - 0.5) * shakeAmount; dy = (Math.random() - 0.5) * shakeAmount; shakeAmount *= 0.85; if (shakeAmount < 0.5) shakeAmount = 0; }
    ctx.save();
    ctx.translate(dx, dy);
    ctx.clearRect(-20, -20, canvas.width+40, canvas.height+40);
    stars.forEach(star => { ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`; ctx.fillRect(star.x, star.y, star.size, star.size); star.y += star.speed; if (star.y > canvas.height) { star.y = -10; star.x = Math.random() * canvas.width; } });
    player.update(); player.draw();
    if (isBossActive && boss) { boss.update(); boss.draw(); }
    bullets.forEach((b, i) => { b.update(); b.draw(); if (b.y + b.height < 0 || b.x < 0 || b.x > canvas.width) bullets.splice(i, 1); });
    enemyBullets.forEach((eb, i) => { eb.update(); eb.draw(); if (eb.y > canvas.height || eb.y < -100 || eb.x < -100 || eb.x > canvas.width + 100) enemyBullets.splice(i, 1); });
    enemies.forEach((e) => { e.update(); e.draw(); });
    powerUps.forEach((p) => { p.update(); p.draw(); });
    healthPacks.forEach((hp) => { hp.update(); hp.draw(); });
    particles.forEach((p, i) => { p.update(); p.draw(); if (p.life <= 0) particles.splice(i, 1); });
    if (messageTimer > 0) { ctx.fillStyle = 'white'; ctx.font = '16px "Press Start 2P"'; ctx.textAlign = 'center'; ctx.fillText(messageText, canvas.width/2, canvas.height/2); messageTimer--; }
    ctx.restore();
    spawnEnemy(); spawnPowerUp(); checkCollisions();
}

window.addEventListener('keydown', (e) => { keys[e.key] = true; if (e.key === ' ' && gameActive && player.weaponType !== WEAPON_TYPES.LASER) player.shoot(); });
window.addEventListener('keyup', (e) => { keys[e.key] = false; });

async function initAudio() {
    if (!audioCtx) audioCtx = new AudioCtx();
    await audioCtx.resume();
    if (!bgmBuffer) await loadBGM();
}

startBtn.addEventListener('click', async () => {
    isVersus = false;
    await initAudio();
    startGame();
});

vsBtn.addEventListener('click', async () => {
    await initAudio();
    if (socket) {
        socket.emit('joinMatch');
    } else {
        alert("無法連接對戰伺服器");
    }
});

restartBtn.addEventListener('click', () => { startGame(); });
