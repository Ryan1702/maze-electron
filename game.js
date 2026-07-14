// ============================================================
// 游戏常量
// ============================================================
const MAZE_SIZE = 41;       // 必须是奇数
const CELL_SIZE = 16;       // 每格像素大小
const FOG_RADIUS = 3;       // 视野半径（曼哈顿距离）
const MOVE_COOLDOWN = 120;  // 移动冷却时间（毫秒）

// ============================================================
// DOM 元素引用
// ============================================================
const canvas = document.getElementById('mazeCanvas');
const ctx = canvas.getContext('2d');
const timeDisplay = document.getElementById('time-display');
const stepsDisplay = document.getElementById('steps-display');
const newGameBtn = document.getElementById('new-game-btn');

// ============================================================
// 游戏状态
// ============================================================
let maze = [];              // 二维数组，0=通道，1=墙壁
let playerX = 1;
let playerY = 1;
let steps = 0;
let timerSeconds = 0;
let timerInterval = null;
let gameStarted = false;    // 是否已开始（第一次移动触发计时）
let gameOver = false;       // 是否已通关

// 按键状态与移动冷却
const keysPressed = {};
let lastMoveTime = 0;
let gameLoopId = null;

// ============================================================
// 迷宫生成：两步法 — 散布主路径 + 疯狂分叉
//
// 核心迷惑设计（从玩家心理角度）：
//   - 起点到终点有且只有一条正确路径（完美迷宫，无环路）
//   - 主路径短（占内部总格子 15%~20%），但像藤蔓蜿蜒散布全图
//   - 主路径间隙中塞满蜿蜒死胡同，几乎每走一两步就遇到分叉
//   - 每个分叉口正确方向随机（时而远离终点、时而靠近终点）
//   - 死胡同内部也曲折，不会一眼望穿
//
// 第一步：区块引导 + 交替偏好 → 主路径均匀散布
//   - 把迷宫分成 4×4 区块（每块约 10×10 格）
//   - 优先选访问次数最少的区块，将主路径"推"向未涉足区域
//   - 每 4~8 步切换远离/靠近终点偏好，各 50%，不连续两次相同
//   - 接近 maxSteps 时放弃区块均匀，尽快导向终点
//
// 第二步：从主路径每个点疯狂分叉
//   - 主路径所有格子随机打乱全压入栈
//   - 标准递归回溯填充所有剩余格子
//   - 80% 概率沿当前方向继续延伸，20% 强制垂直转弯
//   - 死胡同内部蜿蜒曲折，填满主路径间隙
// ============================================================

// 四个跳两格方向（dx, dy 均为 ±2，中间格同步打通）
const DIRS = [
  { dx: 0, dy: -2, key: 'up' },
  { dx: 0, dy: 2,  key: 'down' },
  { dx: -2, dy: 0, key: 'left' },
  { dx: 2, dy: 0,  key: 'right' },
];

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// ============================================================
// 工具：计算格子所属区块（4×4 均匀划分内部 39×39 区域）
// 每块约 10×10 格，用于区块均匀散布策略
// ============================================================
function getZone(x, y) {
  const zoneW = Math.ceil(39 / 4);  // 10
  const zoneH = Math.ceil(39 / 4);  // 10
  const zx = Math.min(Math.floor((x - 1) / zoneW), 3);
  const zy = Math.min(Math.floor((y - 1) / zoneH), 3);
  return zy * 4 + zx;
}

// ============================================================
// 工具：Fisher-Yates 洗牌（用于随机打乱主路径点顺序）
// ============================================================
function shuffle(arr) {
  const a = arr.slice();  // 浅拷贝，不修改原数组
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============================================================
// 第一步：生成散布全图的短主路径
//
// 使用区块均匀策略 + 交替偏好，让主路径像细长藤蔓贯穿全图。
// 主路径目标长度：60~80步（内部奇数格的15%~20%）。
// 阶段1：区块引导游走 ~55步，散布到8+区块
// 阶段2：贪心导向终点（不回退），最终长度60~95
//
// 参数：
//   m       - 当前迷宫（全墙初始化），会被原地修改
//   visited - 空 Set，记录主路径已访问的奇数格 key "x,y"
// 返回：主路径点数组 [{x, y}, ...]
// ============================================================
function generateMainPath(m, visited) {
  const GOAL_X = 39;
  const GOAL_Y = 39;
  const TOTAL_ODD = 400;
  const PHASE1_TARGET = 55;     // 阶段1目标步数（区块散布）
  const MAX_TOTAL = 95;         // 主路径总长度上限

  // 区块访问计数（16个区块，0~15）
  const zoneVisits = new Array(16).fill(0);

  const mainPath = [];

  // 起点初始化
  m[1][1] = 0;
  visited.add('1,1');
  zoneVisits[getZone(1, 1)]++;
  mainPath.push({ x: 1, y: 1 });

  // 交替偏好状态：true=靠近终点，false=远离终点
  // 阶段1期间使用远离偏好主导（60%远离，40%靠近），让路径绕远散布
  let preferToward = Math.random() < 0.4;  // 40%靠近
  let stepsSinceSwitch = 0;
  let switchThreshold = 4 + Math.floor(Math.random() * 5);

  // ========== 阶段1：区块引导游走 ==========
  // 使用显式栈，DFS风格，优先未探索区块，长度控制在 PHASE1_TARGET
  const stack = [{ x: 1, y: 1 }];

  while (stack.length > 0 && mainPath.length < PHASE1_TARGET) {
    const cur = stack[stack.length - 1];

    const raw = [];
    for (const d of DIRS) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (
        nx >= 1 && nx <= 39 &&
        ny >= 1 && ny <= 39 &&
        !visited.has(`${nx},${ny}`)
      ) {
        const mx = cur.x + d.dx / 2;
        const my = cur.y + d.dy / 2;
        raw.push({ nx, ny, mx, my, dir: d.key });
      }
    }

    if (raw.length === 0) {
      stack.pop();
      continue;
    }

    // 计算每个候选的区块和距离
    const augmented = raw.map(c => ({
      ...c,
      zone: getZone(c.nx, c.ny),
      dist: Math.abs(c.nx - GOAL_X) + Math.abs(c.ny - GOAL_Y),
    }));

    // 综合打分：区块均匀（权重6）+ 远近偏好（权重3）
    const scored = augmented.map(c => {
      const allZones = augmented.map(cc => zoneVisits[cc.zone]);
      const zMin = Math.min(...allZones);
      const zMax = Math.max(...allZones);
      const zRng = (zMax - zMin) || 1;
      const zScore = (zMax - zoneVisits[c.zone]) / zRng;
      const zPart = zScore * 6.0;

      const allDists = augmented.map(cc => cc.dist);
      const dMin = Math.min(...allDists);
      const dMax = Math.max(...allDists);
      const dRng = (dMax - dMin) || 1;
      const dNorm = preferToward ? (dMax - c.dist) / dRng : (c.dist - dMin) / dRng;
      const dPart = dNorm * 3.0;

      const noise = (Math.random() - 0.5) * 1.0;
      return { ...c, score: zPart + dPart + noise };
    });

    // 加权随机选择
    const weights = scored.map(s => Math.exp(Math.max(s.score, -20) * 0.7));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * totalWeight;
    let chosen;
    for (let i = 0; i < scored.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { chosen = scored[i]; break; }
    }
    if (!chosen) chosen = scored[scored.length - 1];

    // 打通
    m[chosen.my][chosen.mx] = 0;
    m[chosen.ny][chosen.nx] = 0;
    visited.add(`${chosen.nx},${chosen.ny}`);
    zoneVisits[chosen.zone]++;
    mainPath.push({ x: chosen.nx, y: chosen.ny });
    stack.push({ x: chosen.nx, y: chosen.ny });

    // 交替偏好切换
    stepsSinceSwitch++;
    if (stepsSinceSwitch >= switchThreshold) {
      const oldPref = preferToward;
      // 阶段1：60%远离，40%靠近
      preferToward = Math.random() < 0.4;
      if (preferToward === oldPref && augmented.length > 1) {
        preferToward = !oldPref;
      }
      stepsSinceSwitch = 0;
      switchThreshold = 4 + Math.floor(Math.random() * 5);
    }
  }

  // ========== 阶段2：贪心导向终点 ==========
  // 从当前主路径末端，纯贪心（选距离终点最近的未访问邻居）走向终点
  // 不回退，不回溯，确保最终长度在可控范围内
  let cur = mainPath[mainPath.length - 1];
  while (cur.x !== GOAL_X || cur.y !== GOAL_Y) {
    const raw = [];
    for (const d of DIRS) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (
        nx >= 1 && nx <= 39 &&
        ny >= 1 && ny <= 39 &&
        !visited.has(`${nx},${ny}`)
      ) {
        const mx = cur.x + d.dx / 2;
        const my = cur.y + d.dy / 2;
        raw.push({ nx, ny, mx, my, dist: Math.abs(nx - GOAL_X) + Math.abs(ny - GOAL_Y) });
      }
    }

    if (raw.length === 0) {
      // 被困住：沿主路径回溯找到出路
      let found = false;
      for (let idx = mainPath.length - 2; idx >= 0; idx--) {
        const pt = mainPath[idx];
        for (const d of DIRS) {
          const nx = pt.x + d.dx;
          const ny = pt.y + d.dy;
          if (nx >= 1 && nx <= 39 && ny >= 1 && ny <= 39 && !visited.has(`${nx},${ny}`)) {
            // 从这个回溯点重新贪心走向终点
            cur = pt;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) break;  // 完全无路（极罕见）
      continue;
    }

    // 贪心：选距离终点最近的
    let best = raw[0];
    for (let i = 1; i < raw.length; i++) {
      if (raw[i].dist < best.dist) best = raw[i];
    }

    m[best.my][best.mx] = 0;
    m[best.ny][best.nx] = 0;
    visited.add(`${best.nx},${best.ny}`);
    mainPath.push({ x: best.nx, y: best.ny });
    cur = { x: best.nx, y: best.ny };
  }

  return mainPath;
}

// ============================================================
// 第二步：从主路径每个点疯狂分叉，填满所有剩余格子
//
// 主路径每个格子都作为分支种子，随机打乱全部压入栈。
// 标准递归回溯填充，80% 沿当前方向延伸、20% 垂直转弯，
// 让死胡同内部也蜿蜒曲折。
//
// 参数：
//   m              - 已有主路径的迷宫，会被原地修改填满分叉
//   visited        - 已含主路径点的 Set，会被扩展
//   mainPathPoints - 主路径点数组
// ============================================================
function generateBranches(m, visited, mainPathPoints) {
  // 记录每个已访问格子的"来向"（进入方向 key），用于蜿蜒延伸策略
  const parentDir = {};  // key "x,y" → 'up'|'down'|'left'|'right'

  // 从主路径相邻关系推断来向
  for (let i = 1; i < mainPathPoints.length; i++) {
    const prev = mainPathPoints[i - 1];
    const cur = mainPathPoints[i];
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    let dirKey = null;
    if (dy === -2) dirKey = 'up';
    else if (dy === 2) dirKey = 'down';
    else if (dx === -2) dirKey = 'left';
    else if (dx === 2) dirKey = 'right';
    if (dirKey) {
      parentDir[`${cur.x},${cur.y}`] = dirKey;
    }
  }

  // 主路径所有点随机打乱，全部压入栈
  const stack = shuffle(mainPathPoints);

  // 标准递归回溯：栈顶 peek，有邻居则延伸，无邻居则弹出
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];  // peek 栈顶
    const key = `${cur.x},${cur.y}`;
    const prevDir = parentDir[key] || null;

    // 收集未访问的跳两格邻居
    const raw = [];
    for (const d of DIRS) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (
        nx >= 1 && nx <= 39 &&
        ny >= 1 && ny <= 39 &&
        !visited.has(`${nx},${ny}`)
      ) {
        const mx = cur.x + d.dx / 2;
        const my = cur.y + d.dy / 2;
        raw.push({ nx, ny, mx, my, dir: d.key });
      }
    }

    if (raw.length === 0) {
      // 无未访问邻居 → 回溯
      stack.pop();
      continue;
    }

    // ---- 蜿蜒策略：80% 沿当前方向继续，20% 强制垂直转弯 ----
    let candidates = raw;

    if (prevDir && raw.length > 1 && Math.random() < 0.8) {
      // 80%：优先同向延伸（让死胡同内部连续蜿蜒）
      const sameDir = raw.filter(c => c.dir === prevDir);
      if (sameDir.length > 0) {
        candidates = sameDir;
      }
    } else if (prevDir && raw.length > 1) {
      // 20%：强制垂直转弯
      const perpendicular = raw.filter(c => {
        const isVertical =
          (prevDir === 'up' || prevDir === 'down') && (c.dir === 'left' || c.dir === 'right');
        const isHorizontal =
          (prevDir === 'left' || prevDir === 'right') && (c.dir === 'up' || c.dir === 'down');
        return isVertical || isHorizontal;
      });
      if (perpendicular.length > 0) {
        candidates = perpendicular;
      }
    }

    // 在候选集合中随机选一个
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];

    // 打通中间墙 + 目标格
    m[chosen.my][chosen.mx] = 0;
    m[chosen.ny][chosen.nx] = 0;
    visited.add(`${chosen.nx},${chosen.ny}`);
    parentDir[`${chosen.nx},${chosen.ny}`] = chosen.dir;

    // 压入新格子
    stack.push({ x: chosen.nx, y: chosen.ny });
  }

  // 确保终点是通道（分支填充可能覆盖不到）
  m[39][39] = 0;
}

// ============================================================
// 生成完整迷宫（两步法入口）
// 返回 MAZE_SIZE × MAZE_SIZE 的二维数组，0=通道，1=墙壁
// ============================================================
function generateMaze() {
  // 初始化为全墙
  const m = [];
  for (let y = 0; y < MAZE_SIZE; y++) {
    m[y] = new Array(MAZE_SIZE).fill(1);
  }

  const visited = new Set();  // 记录已访问的奇数格 key "x,y"

  // 第一步：生成散布全图的短主路径（占 15%~20%）
  const mainPath = generateMainPath(m, visited);

  // 第二步：从主路径每个点疯狂分叉，填满所有剩余格子
  generateBranches(m, visited, mainPath);

  // 为确保安全，再次标记起点终点为通道
  m[1][1] = 0;
  m[MAZE_SIZE - 2][MAZE_SIZE - 2] = 0;

  return m;
}

// ============================================================
// 计算曼哈顿距离
// ============================================================
function manhattanDistance(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

// ============================================================
// 绘制迷宫（迷雾系统 + 线条风格墙壁）
//
// 线条迷宫风格：
//   - 画布底色为深色通道 (#1a1a1a)
//   - 墙只占格子之间约 2px 的亮色细线 (#aaa)
//   - 以通道格为中心：每个通道格检查四边，遇到墙或边界就画墙线
//   - 外圈边界始终画完整的闭合墙线框
//   - 迷雾：曼哈顿距离 > 3 的格子整格涂黑
//   - 玩家 / 起点 / 终点以圆形标记绘制
// ============================================================
function drawMaze() {
  const WALL_COLOR = '#aaa';
  const WALL_WIDTH = 2;
  const FLOOR_COLOR = '#1a1a1a';

  const width = MAZE_SIZE * CELL_SIZE;
  const height = MAZE_SIZE * CELL_SIZE;
  canvas.width = width;
  canvas.height = height;

  // 1. 整个画布填充通道底色
  ctx.fillStyle = FLOOR_COLOR;
  ctx.fillRect(0, 0, width, height);

  // 2. 先画迷宫最外圈边界（始终可见的闭合矩形框）
  ctx.strokeStyle = WALL_COLOR;
  ctx.lineWidth = WALL_WIDTH;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.stroke();

  // 3. 迷雾覆盖：超出视野的格子整格涂黑
  for (let y = 0; y < MAZE_SIZE; y++) {
    for (let x = 0; x < MAZE_SIZE; x++) {
      const dist = manhattanDistance(x, y, playerX, playerY);
      if (dist > FOG_RADIUS) {
        ctx.fillStyle = '#000';
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }
  }

  // 4. 在可见区域内绘制内部墙线
  // 以通道格为基准：通道格检查四边，相邻是墙(1)则在该边画线
  ctx.strokeStyle = WALL_COLOR;
  ctx.lineWidth = WALL_WIDTH;
  ctx.lineCap = 'round';
  ctx.beginPath();

  for (let y = 0; y < MAZE_SIZE; y++) {
    for (let x = 0; x < MAZE_SIZE; x++) {
      const dist = manhattanDistance(x, y, playerX, playerY);
      if (dist > FOG_RADIUS) continue;

      // 只处理通道格：通道格检查四个方向是否遇墙
      if (maze[y][x] !== 0) continue;

      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;

      // 上边：上方是墙或边界
      if (y > 0 && maze[y - 1][x] === 1) {
        ctx.moveTo(px, py);
        ctx.lineTo(px + CELL_SIZE, py);
      }
      // 下边：下方是墙或边界
      if (y < MAZE_SIZE - 1 && maze[y + 1][x] === 1) {
        ctx.moveTo(px, py + CELL_SIZE);
        ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE);
      }
      // 左边：左方是墙或边界
      if (x > 0 && maze[y][x - 1] === 1) {
        ctx.moveTo(px, py);
        ctx.lineTo(px, py + CELL_SIZE);
      }
      // 右边：右方是墙或边界
      if (x < MAZE_SIZE - 1 && maze[y][x + 1] === 1) {
        ctx.moveTo(px + CELL_SIZE, py);
        ctx.lineTo(px + CELL_SIZE, py + CELL_SIZE);
      }
    }
  }
  ctx.stroke();

  // 5. 绘制终点（红色圆点）- 只在视野内可见
  const goalX = MAZE_SIZE - 2;
  const goalY = MAZE_SIZE - 2;
  if (manhattanDistance(goalX, goalY, playerX, playerY) <= FOG_RADIUS) {
    drawCircle(goalX, goalY, '#f00', CELL_SIZE * 0.35);
  }

  // 6. 绘制起点（绿色圆点）- 始终在视野内
  drawCircle(1, 1, '#0f0', CELL_SIZE * 0.35);

  // 7. 绘制玩家（黄色圆点，稍大）
  drawCircle(playerX, playerY, '#ff0', CELL_SIZE * 0.4);
}

// ============================================================
// 在指定格子中心绘制实心圆
// ============================================================
function drawCircle(gridX, gridY, color, radius) {
  const cx = gridX * CELL_SIZE + CELL_SIZE / 2;
  const cy = gridY * CELL_SIZE + CELL_SIZE / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
}

// ============================================================
// 更新 HTML 显示
// ============================================================
function updateDisplay() {
  stepsDisplay.textContent = `👣 步数: ${steps}`;
  const mins = Math.floor(timerSeconds / 60);
  const secs = timerSeconds % 60;
  const timeStr = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  timeDisplay.textContent = `⏱ 时间: ${timeStr}`;
}

// ============================================================
// 开始计时
// ============================================================
function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateDisplay();
  }, 1000);
}

// ============================================================
// 停止计时
// ============================================================
function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ============================================================
// 重置计时（清零并停止）
// ============================================================
function resetTimer() {
  stopTimer();
  timerSeconds = 0;
  updateDisplay();
}

// ============================================================
// 尝试移动玩家
// ============================================================
function tryMove(dx, dy) {
  if (gameOver) return;

  const newX = playerX + dx;
  const newY = playerY + dy;

  // 边界检测
  if (newX < 0 || newX >= MAZE_SIZE || newY < 0 || newY >= MAZE_SIZE) return;

  // 墙壁检测
  if (maze[newY][newX] === 1) return;

  // 移动成功
  playerX = newX;
  playerY = newY;
  steps++;
  updateDisplay();

  // 第一次移动时开始计时
  if (!gameStarted) {
    gameStarted = true;
    startTimer();
  }

  // 胜利检测
  if (playerX === MAZE_SIZE - 2 && playerY === MAZE_SIZE - 2) {
    victory();
  }
}

// ============================================================
// 胜利处理
// ============================================================
function victory() {
  gameOver = true;
  stopTimer();

  // 先绘制最后一帧，让玩家看到自己站在终点
  drawMaze();

  const mins = Math.floor(timerSeconds / 60);
  const secs = timerSeconds % 60;
  const timeStr = `${mins} 分 ${secs} 秒`;

  // 延迟弹窗，确保浏览器完成最后一帧渲染
  requestAnimationFrame(() => {
    alert(`恭喜！你用了 ${timeStr}，共 ${steps} 步。`);
    // 自动重新开始
    newGame();
  });
}

// ============================================================
// 新游戏
// ============================================================
function newGame() {
  stopTimer();
  gameOver = false;
  gameStarted = false;
  steps = 0;
  timerSeconds = 0;
  playerX = 1;
  playerY = 1;
  lastMoveTime = 0;

  // 清空所有残留按键状态，防止上一局弹窗期间
  // keyup 事件被吞掉导致新游戏自动沿残留方向移动
  for (const key in keysPressed) {
    delete keysPressed[key];
  }

  maze = generateMaze();
  updateDisplay();
  drawMaze();
}

// ============================================================
// 游戏循环：处理连续按键移动 + 冷却
// ============================================================
function gameLoop() {
  const now = Date.now();
  if (now - lastMoveTime < MOVE_COOLDOWN) return;

  // 优先级：上 > 下 > 左 > 右
  if (keysPressed['KeyW'] || keysPressed['ArrowUp']) {
    tryMove(0, -1);
    lastMoveTime = now;
  } else if (keysPressed['KeyS'] || keysPressed['ArrowDown']) {
    tryMove(0, 1);
    lastMoveTime = now;
  } else if (keysPressed['KeyA'] || keysPressed['ArrowLeft']) {
    tryMove(-1, 0);
    lastMoveTime = now;
  } else if (keysPressed['KeyD'] || keysPressed['ArrowRight']) {
    tryMove(1, 0);
    lastMoveTime = now;
  }

  drawMaze();
}

// ============================================================
// 键盘事件处理
// ============================================================
function handleKeyDown(e) {
  // 阻止默认行为（防止方向键滚动页面等）
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
  keysPressed[e.code] = true;
}

function handleKeyUp(e) {
  keysPressed[e.code] = false;
}

// ============================================================
// 初始化
// ============================================================
function init() {
  maze = generateMaze();

  // 监听键盘
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  // 新游戏按钮
  newGameBtn.addEventListener('click', newGame);

  // 启动游戏循环（requestAnimationFrame 驱动）
  function loop() {
    gameLoop();
    gameLoopId = requestAnimationFrame(loop);
  }
  gameLoopId = requestAnimationFrame(loop);

  // 初始绘制
  updateDisplay();
  drawMaze();
}

// 页面加载完成后初始化
init();