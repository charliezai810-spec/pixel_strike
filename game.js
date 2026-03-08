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

// FPS 同步
let lastTime = performance.now();
const fpsInterval = 1000 / 60;

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

// --- 音效與音樂 ---
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx;
const bgm = new Audio('bgm.mp3');
bgm.loop = true;
bgm.volume = 0;

function fadeInBGM(targetVol = 0.25, duration = 2000) {
    bgm.play();
    let startTime = performance.now();
    function up() {
        let elapsed = performance.now() - startTime;
        let p = Math.min(elapsed / duration, 1);
        bgm.volume = p * targetVol;
        if (p < 1 && gameActive) requestAnimationFrame(up);
    }
    requestAnimationFrame(up);
}

function fadeOutBGM() {
    let startVol = bgm.volume;
    let startTime = performance.now();
    function up() {
        let elapsed = performance.now() - startTime;
        let p = Math.min(elapsed / 1500, 1);
        bgm.volume = startVol * (1 - p);
        if (p < 1) requestAnimationFrame(up);
        else bgm.pause();
    }
    requestAnimationFrame(up);
}

function playSound(freq, type, duration, vol = 0.1) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + duration);
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); osc.stop(audioCtx.currentTime + duration);
}

const SFX = {
    shoot: () => playSound(600, 'square', 0.1, 0.1),
    laser: () => playSound(1800, 'sine', 0.05, 0.2),
    explode: () => { playSound(100, 'sawtooth', 0.3, 0.3); playSound(50, 'triangle', 0.4, 0.4); },
    powerup: () => [440, 554, 659, 880].forEach((n, i) => setTimeout(() => playSound(n, 'sine', 0.2, 0.1), i * 60)),
    heal: () => [523, 659, 783, 1046].forEach((n, i) => setTimeout(() => playSound(n, 'triangle', 0.3, 0.1), i * 50)),
    levelUp: () => [200, 300, 400, 600].forEach((n, i) => setTimeout(() => playSound(n, 'square', 0.4, 0.1), i * 100))
};

// --- 連線 ---
let isVersus = false;
let socket = (typeof io !== 'undefined') ? io() : null;
let currentRoom = null;

if (socket) {
    socket.on('waitingForOpponent', () => { titleText.textContent = "WAITING..."; desc1Text.textContent = "SEARCHING FOR OPPONENT"; startBtn.style.display = 'none'; vsBtn.style.display = 'none'; });
    socket.on('matchFound', (data) => { currentRoom = data.room; isVersus = true; startGame(); });
    socket.on('receiveGarbage', (data) => { if (gameActive) { const e = new Enemy(undefined, -70, data.type); e.isGarbage = true; enemies.push(e); } });
}

// --- 資源載入 ---
for(let i=0; i<100; i++) stars.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, size: Math.random() * 2 + 1, speed: Math.random() * 2 + 0.5, opacity: Math.random() * 0.5 + 0.3 });

const playerImgs = { CENTER: new Image(), LEFT: new Image(), RIGHT: new Image() };
playerImgs.CENTER.src = 'player_nobg.png'; playerImgs.LEFT.src = 'player_left.png'; playerImgs.RIGHT.src = 'player_right.png';

const enemyImgs = { std: { CENTER: new Image() }, sniper: { CENTER: new Image() }, bomber: { CENTER: new Image() }, seeker: { CENTER: new Image() } };
['std', 'sniper', 'bomber', 'seeker'].forEach(k => { enemyImgs[k].CENTER.src = `enemy_${k}.png`; });
const bossImg = new Image(); bossImg.src = 'boss.png';

const WEAPON_TYPES = { NORMAL: 'NORMAL', TRIPLE: 'TRIPLE', SPREAD: 'SPREAD', LASER: 'LASER' };
const ENEMY_TYPES = {
    STANDARD: { asset: 'std', shootChance: 0.01, bulletType: 'NORMAL' },
    SNIPER: { asset: 'sniper', shootChance: 0.005, bulletType: 'FAST' },
    BOMBER: { asset: 'bomber', shootChance: 0.012, bulletType: 'SPREAD' },
    SEEKER: { asset: 'seeker', shootChance: 0.007, bulletType: 'HOMING' }
};

class Player {
    constructor() { this.width = 60; this.height = 60; this.x = 270; this.y = 650; this.speed = 6; this.weaponType = WEAPON_TYPES.NORMAL; this.powerUpTimer = 0; this.tilt = 'CENTER'; this.hitShake = 0; this.invincibleTimer = 0; }
    draw() {
        if (this.invincibleTimer > 0 && frameCount % 6 < 3) return;
        const x = Math.round(this.x), y = Math.round(this.y), w = this.width, h = this.height;
        ctx.save();
        if (this.hitShake > 0) ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake);
        const img = playerImgs[this.tilt];
        if (img.complete && img.naturalWidth !== 0) {
            ctx.shadowBlur = 10; ctx.shadowColor = '#38d9a9';
            ctx.drawImage(img, x, y, w, h);
        } else {
            ctx.fillStyle = '#38d9a9'; ctx.fillRect(x, y, w, h);
        }
        if (this.powerUpTimer > 0) {
            ctx.globalCompositeOperation = 'source-atop';
            const colors = { TRIPLE: 'rgba(72, 52, 212, 0.5)', SPREAD: 'rgba(106, 176, 76, 0.5)', LASER: 'rgba(190, 46, 221, 0.5)' };
            ctx.fillStyle = colors[this.weaponType]; ctx.fillRect(x, y, w, h);
        }
        ctx.restore();
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
        this.x = Math.max(0, Math.min(540, this.x)); this.y = Math.max(80, Math.min(720, this.y));
        if (this.powerUpTimer > 0) { this.powerUpTimer--; if (this.powerUpTimer <= 0) this.weaponType = WEAPON_TYPES.NORMAL; }
        if (this.weaponType === WEAPON_TYPES.LASER && keys[' '] && gameActive) this.shoot();
    }
    shoot() {
        if (this.weaponType === WEAPON_TYPES.LASER) SFX.laser(); else SFX.shoot();
        const cx = this.x + 30, ty = this.y;
        switch(this.weaponType) {
            case WEAPON_TYPES.TRIPLE: bullets.push(new Bullet(cx, ty), new Bullet(cx-20, ty+10), new Bullet(cx+20, ty+10)); break;
            case WEAPON_TYPES.SPREAD: for(let i=-2; i<=2; i++) bullets.push(new Bullet(cx, ty, i * 1.5)); break;
            case WEAPON_TYPES.LASER: bullets.push(new Bullet(cx, ty, 0, 10, 50, 25, '#be2edd', true)); break;
            default: bullets.push(new Bullet(cx, ty));
        }
    }
    takeDamage() { if (this.invincibleTimer > 0) return; health--; this.hitShake = 25; this.invincibleTimer = 60; SFX.explode(); updateUI(); if (health <= 0) { gameActive = false; fadeOutBGM(); gameOver(); } }
}

class Enemy {
    constructor(x, y, forcedType = null) {
        const typeKeys = Object.keys(ENEMY_TYPES);
        const typeKey = forcedType || typeKeys[Math.floor(Math.random() * 4)];
        const cfg = ENEMY_TYPES[typeKey];
        this.type = typeKey; this.width = 70; this.height = 70;
        this.x = (x !== undefined) ? x : Math.random() * 530;
        this.y = (y !== undefined) ? y : -70;
        this.baseSpeed = (0.8 + Math.random() * 1.2) * difficultyMultiplier;
        this.speed = this.baseSpeed; this.vx = 0; this.assetKey = cfg.asset; this.shootChance = cfg.shootChance * difficultyMultiplier; this.bulletType = cfg.bulletType;
        this.aiTimer = 0; this.hitShake = 0; this.isGarbage = false;
    }
    draw() {
        ctx.save();
        if (this.hitShake > 0) ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake);
        if (this.isGarbage) { ctx.shadowBlur = 15; ctx.shadowColor = 'red'; }
        const img = enemyImgs[this.assetKey].CENTER;
        if (img.complete && img.naturalWidth !== 0) ctx.drawImage(img, this.x, this.y, 70, 70);
        else { ctx.fillStyle = '#ff4757'; ctx.fillRect(this.x, this.y, 70, 70); }
        ctx.restore();
    }
    update() {
        if (this.hitShake > 0) this.hitShake *= 0.8;
        this.aiTimer--;
        if (this.aiTimer <= 0) {
            const r = Math.random();
            if (r < 0.6) { this.vx = 0; this.speed = this.baseSpeed; this.aiTimer = 60; }
            else if (r < 0.9) { this.vx = (Math.random()-0.5)*4; this.aiTimer = 100; }
            else { this.speed = this.baseSpeed + 3; this.aiTimer = 40; }
        }
        this.y += this.speed; this.x += this.vx;
        if (this.x < 0 || this.x > 530) this.vx *= -1;
        if (gameActive && Math.random() < this.shootChance) this.shoot();
    }
    shoot() {
        const cx = this.x + 35, cy = this.y + 70;
        switch(this.bulletType) {
            case 'FAST': enemyBullets.push(new EnemyBullet(cx, cy, { speed: 10, width: 4, height: 24, color: '#eccc68' })); break;
            case 'SPREAD': [-2, 0, 2].forEach(v => enemyBullets.push(new EnemyBullet(cx, cy, { vx: v, color: '#7bed9f' }))); break;
            case 'HOMING': enemyBullets.push(new EnemyBullet(cx, cy, { speed: 3, isHoming: true, color: '#a29bfe', width: 14, height: 14 })); break;
            default: enemyBullets.push(new EnemyBullet(cx, cy));
        }
    }
}

class Boss {
    constructor() { this.width = 300; this.height = 300; this.x = 150; this.y = -300; this.maxHealth = 150 * difficultyMultiplier; this.health = this.maxHealth; this.speedX = 2; this.state = 'ENTERING'; this.attackTimer = 0; this.hitShake = 0; }
    draw() {
        ctx.save();
        if (this.hitShake > 0) ctx.translate((Math.random()-0.5)*this.hitShake, (Math.random()-0.5)*this.hitShake);
        if (bossImg.complete) ctx.drawImage(bossImg, this.x, this.y, 300, 300);
        else { ctx.fillStyle = '#ff4757'; ctx.fillRect(this.x, this.y, 300, 300); }
        ctx.restore();
        ctx.fillStyle = '#2f3542'; ctx.fillRect(75, 45, 450, 25);
        ctx.fillStyle = '#ff4757'; ctx.fillRect(75, 45, 450 * (this.health / this.maxHealth), 25);
        ctx.strokeStyle = 'white'; ctx.strokeRect(75, 45, 450, 25);
    }
    update() {
        if (this.hitShake > 0) this.hitShake *= 0.85;
        if (this.state === 'ENTERING') { this.y += 1.5; if (this.y >= 100) this.state = 'BATTLE'; }
        else {
            this.x += this.speedX; if (this.x <= 0 || this.x > 300) this.speedX *= -1;
            this.attackTimer++;
            if (this.attackTimer % 60 === 0) { for(let i=0; i<12; i++) { const a = (i/12)*Math.PI*2; enemyBullets.push(new EnemyBullet(this.x+150, this.y+150, { vx: Math.cos(a)*3, speed: Math.sin(a)*3+3, color: '#ff4757', width: 12, height: 12 })); } }
            if (this.attackTimer % 120 === 0) enemyBullets.push(new EnemyBullet(this.x+150, this.y+300, { isHoming: true, speed: 4, color: '#be2edd', width: 20, height: 20 }));
        }
    }
}

class Bullet { constructor(x, y, vx=0, w=8, h=16, s=10, c='#fff200', isl=false) { this.x=x-w/2; this.y=y; this.vx=vx; this.width=w; this.height=h; this.speed=s; this.color=c; this.isLaser=isl; } draw() { ctx.fillStyle=this.color; ctx.fillRect(this.x, this.y, this.width, this.height); } update() { this.y-=this.speed; this.x+=this.vx; } }
class EnemyBullet { constructor(x, y, opt={}) { this.x=x; this.y=y; this.width=opt.width||8; this.height=opt.height||8; this.speed=opt.speed||5; this.vx=opt.vx||0; this.color=opt.color||'#ff4757'; this.isHoming=opt.isHoming||false; } draw() { ctx.fillStyle=this.color; ctx.fillRect(this.x-this.width/2, this.y, this.width, this.height); } update() { if(this.isHoming && player){ let dx=(player.x+30)-this.x; this.vx+=Math.sign(dx)*0.12; this.vx=Math.max(-2.5, 2.5); } this.y+=this.speed; this.x+=this.vx; } }
class Particle { constructor(x, y, c) { this.x=x; this.y=y; this.size=Math.random()*8+4; this.sx=(Math.random()-0.5)*10; this.sy=(Math.random()-0.5)*10; this.color=c; this.life=1; } draw() { ctx.globalAlpha=this.life; ctx.fillStyle=this.color; ctx.fillRect(this.x, this.y, this.size, this.size); ctx.globalAlpha=1; } update() { this.x+=this.sx; this.y+=this.sy; this.life-=0.05; } }
class PowerUp { constructor() { this.width=32; this.height=32; this.x=Math.random()*560; this.y=-32; this.speed=3; const t=[WEAPON_TYPES.TRIPLE, WEAPON_TYPES.SPREAD, WEAPON_TYPES.LASER]; this.type=t[Math.floor(Math.random()*3)]; this.color=(this.type==='TRIPLE')?'#4834d4':(this.type==='SPREAD'?'#6ab04c':'#be2edd'); } draw() { ctx.fillStyle=this.color; ctx.fillRect(this.x, this.y, 32, 32); ctx.fillStyle='white'; ctx.font='12px "Press Start 2P"'; ctx.textAlign='center'; ctx.fillText(this.type[0], this.x+16, this.y+22); } update() { this.y+=this.speed; this.x+=Math.sin(this.y/25)*3; } }
class HealthPack { constructor(x, y) { this.width=32; this.height=32; this.x=x; this.y=y; this.speed=2.5; } draw() { ctx.fillStyle='#ff4757'; ctx.fillRect(this.x, this.y, 32, 32); ctx.fillStyle='white'; ctx.fillRect(this.x+12, this.y+6, 8, 20); ctx.fillRect(this.x+6, this.y+12, 20, 8); } update() { this.y+=this.speed; } }

function startGame() { score=0; health=3; gameActive=true; enemies=[]; bullets=[]; enemyBullets=[]; particles=[]; powerUps=[]; healthPacks=[]; boss=null; isBossActive=false; nextBossScore=500; difficultyMultiplier=1.0; updateUI(); startOverlay.classList.add('hidden'); overlay.classList.add('hidden'); fadeInBGM(); lastTime=performance.now(); animate(performance.now()); }
function updateUI() { scoreElement.textContent = `SCORE: ${score.toString().padStart(4, '0')}`; healthContainer.innerHTML = ''; for (let i=0; i<3; i++) { const h = document.createElement('span'); h.className='heart'; h.textContent=i<health?'❤️':'🖤'; healthContainer.appendChild(h); } }
function gameOver() { finalScoreElement.textContent=score; overlay.classList.remove('hidden'); }

function animate(t) {
    if (!gameActive) return;
    requestAnimationFrame(animate);
    const dt = t - lastTime;
    if (dt < fpsInterval) return;
    lastTime = t - (dt % fpsInterval);
    frameCount++;
    ctx.clearRect(0, 0, 600, 800);
    stars.forEach(s => { ctx.fillStyle=`rgba(255,255,255,${s.opacity})`; ctx.fillRect(s.x, s.y, s.size, s.size); s.y+=s.speed; if(s.y>800){ s.y=-10; s.x=Math.random()*600; } });
    player.update(); player.draw();
    if(isBossActive && boss){ boss.update(); boss.draw(); }
    bullets.forEach((b, i) => { b.update(); b.draw(); if(b.y < -50) bullets.splice(i, 1); });
    enemyBullets.forEach((eb, i) => { eb.update(); eb.draw(); if(eb.y > 850) enemyBullets.splice(i, 1); });
    enemies.forEach((e, i) => { e.update(); e.draw(); if(e.y > 850) { enemies.splice(i, 1); player.takeDamage(); } });
    powerUps.forEach((p, i) => { p.update(); p.draw(); if(p.y > 850) powerUps.splice(i, 1); });
    healthPacks.forEach((h, i) => { h.update(); h.draw(); if(h.y > 850) healthPacks.splice(i, 1); });
    particles.forEach((p, i) => { p.update(); p.draw(); if(p.life <= 0) particles.splice(i, 1); });
    if(messageTimer > 0) { ctx.fillStyle='white'; ctx.font='16px "Press Start 2P"'; ctx.textAlign='center'; ctx.fillText(messageText, 300, 400); messageTimer--; }
    
    // 碰撞偵測
    bullets.forEach((b, bi) => {
        enemies.forEach((e, ei) => {
            if(b.x < e.x+e.width && b.x+b.width > e.x && b.y < e.y+e.height && b.y+b.height > e.y){
                e.hitShake = 15; SFX.explode(); if(health < 3 && Math.random() < 0.03) healthPacks.push(new HealthPack(e.x+20, e.y+20)); if(isVersus && !e.isGarbage) socket.emit('sendGarbage', { room: currentRoom, type: e.type });
                enemies.splice(ei, 1); if(!b.isLaser) bullets.splice(bi, 1); score+=10; updateUI();
            }
        });
        if(isBossActive && boss && b.x < boss.x+boss.width && b.x+b.width > boss.x && b.y < boss.y+boss.height && b.y+b.height > boss.y){
            boss.health -= (b.isLaser?0.5:1); boss.hitShake=10; if(!b.isLaser) bullets.splice(bi, 1);
            if(boss.health <= 0){ SFX.levelUp(); SFX.explode(); score+=500; health=Math.min(3, health+1); isBossActive=false; boss=null; nextBossScore+=1000; difficultyMultiplier+=0.2; messageText="THREAT LEVEL UP!"; messageTimer=120; updateUI(); }
        }
    });
    enemyBullets.forEach((eb, ei) => { if(eb.x < player.x+player.width && eb.x+eb.width > player.x && eb.y < player.y+player.height && eb.y+eb.height > player.y){ enemyBullets.splice(ei, 1); player.takeDamage(); } });
    enemies.forEach((e, ei) => { if(e.x < player.x+player.width && e.x+e.width > player.x && e.y < player.y+player.height && e.y+e.height > player.y){ enemies.splice(ei, 1); player.takeDamage(); } });
    if(isBossActive && boss && boss.x < player.x+player.width && boss.x+boss.width > player.x && boss.y < player.y+player.height && boss.y+boss.height > player.y){ health=0; updateUI(); gameActive=false; fadeOutBGM(); gameOver(); }
    powerUps.forEach((p, pi) => { if(p.x < player.x+player.width && p.x+p.width > player.x && p.y < player.y+player.height && p.y+p.height > player.y){ player.weaponType=p.type; player.powerUpTimer=480; SFX.powerup(); powerUps.splice(pi, 1); } });
    healthPacks.forEach((h, hi) => { if(h.x < player.x+player.width && h.x+h.width > player.x && h.y < player.y+player.height && h.y+h.height > player.y){ health=Math.min(3, health+1); SFX.heal(); updateUI(); healthPacks.splice(hi, 1); } });

    // 生成敵人
    if(!isBossActive && score < nextBossScore){
        enemySpawnCooldown--;
        if(enemySpawnCooldown <= 0 && enemies.length < 20){
            enemies.push(new Enemy());
            enemySpawnCooldown = Math.max(15, 40 - Math.floor(score/100));
        }
    } else if(score >= nextBossScore && !isBossActive){
        isBossActive = true; boss = new Boss();
    }
    if(Math.random() < 0.002) powerUps.push(new PowerUp());
}

startBtn.addEventListener('click', async () => { if(!audioCtx) audioCtx = new AudioCtx(); await audioCtx.resume(); startGame(); });
vsBtn.addEventListener('click', async () => { if(!audioCtx) audioCtx = new AudioCtx(); await audioCtx.resume(); if(socket) socket.emit('joinMatch'); });
restartBtn.addEventListener('click', () => startGame());
window.addEventListener('keydown', e => keys[e.key] = true);
window.addEventListener('keyup', e => keys[e.key] = false);
