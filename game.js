// ============================================================
// 游戏常量
// ============================================================
const MAZE_SIZE = 41;       // 必须是奇数
const CELL_SIZE = 15;       // 每格像素大小
const FOG_RADIUS = 3;       // 视野半径（曼哈顿距离）
const MOVE_COOLDOWN = 120;  // 移动冷却时间（毫秒）
const EXTRA_OPEN_RATIO = 0.05; // 额外打通墙壁比例

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
// 迷宫生成：迭代 DFS（递归回溯），使用栈实现完美迷宫
// ============================================================
function generatePerfectMaze() {
  // 初始化为全墙
  const m = [];
  for (let y = 0; y < MAZE_SIZE; y++) {
    m[y] = new Array(MAZE_SIZE).fill(1);
  }

  // 起点设为通道
  m[1][1] = 0;

  // 使用栈实现迭代 DFS
  const stack = [];
  stack.push({ x: 1, y: 1 });

  // 四个方向：上、右、下、左（每一步跳两格，中间格也打通）
  const dirs = [
    { dx: 0, dy: -2 },
    { dx: 2, dy: 0 },
    { dx: 0, dy: 2 },
    { dx: -2, dy: 0 },
  ];

  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const { x, y } = current;

    // 收集未访问的邻居（目标格在迷宫范围内且仍是墙壁）
    const neighbors = [];
    for (const d of dirs) {
      const nx = x + d.dx;
      const ny = y + d.dy;
      if (nx >= 1 && nx < MAZE_SIZE && ny >= 1 && ny < MAZE_SIZE && m[ny][nx] === 1) {
        neighbors.push({ nx, ny, mx: x + d.dx / 2, my: y + d.dy / 2 });
      }
    }

    if (neighbors.length > 0) {
      // 随机选择一个未访问邻居
      const chosen = neighbors[Math.floor(Math.random() * neighbors.length)];
      // 打通中间墙壁和目标格
      m[chosen.my][chosen.mx] = 0;
      m[chosen.ny][chosen.nx] = 0;
      stack.push({ x: chosen.nx, y: chosen.ny });
    } else {
      // 无未访问邻居，回溯
      stack.pop();
    }
  }

  return m;
}

// ============================================================
// 随机打通额外墙壁（约 5% 的内墙），创建环路
// ============================================================
function addExtraPassages(m) {
  // 收集所有内部墙壁（不包括外边界）
  const innerWalls = [];
  for (let y = 1; y < MAZE_SIZE - 1; y++) {
    for (let x = 1; x < MAZE_SIZE - 1; x++) {
      if (m[y][x] === 1) {
        // 确认不是边界墙壁
        innerWalls.push({ x, y });
      }
    }
  }

  // 随机打掉约 5% 的内墙
  const count = Math.floor(innerWalls.length * EXTRA_OPEN_RATIO);
  // Fisher-Yates 部分洗牌，选前 count 个
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (innerWalls.length - i));
    const temp = innerWalls[i];
    innerWalls[i] = innerWalls[j];
    innerWalls[j] = temp;
    // 打通
    m[innerWalls[i].y][innerWalls[i].x] = 0;
  }
}

// ============================================================
// 生成完整迷宫
// ============================================================
function generateMaze() {
  const m = generatePerfectMaze();
  addExtraPassages(m);
  // 确保起点和终点是通道
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
// 绘制迷宫
// ============================================================
function drawMaze() {
  const width = MAZE_SIZE * CELL_SIZE;
  const height = MAZE_SIZE * CELL_SIZE;
  canvas.width = width;
  canvas.height = height;

  // 先清空
  ctx.clearRect(0, 0, width, height);

  // 遍历所有格，应用迷雾系统
  for (let y = 0; y < MAZE_SIZE; y++) {
    for (let x = 0; x < MAZE_SIZE; x++) {
      const dist = manhattanDistance(x, y, playerX, playerY);
      const px = x * CELL_SIZE;
      const py = y * CELL_SIZE;

      if (dist > FOG_RADIUS) {
        // 迷雾：纯黑
        ctx.fillStyle = '#000';
        ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
      } else {
        // 可见区域：正常绘制
        if (maze[y][x] === 1) {
          // 墙壁：深灰色
          ctx.fillStyle = '#333';
          ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        } else {
          // 通道：浅灰色
          ctx.fillStyle = '#aaa';
          ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        }
      }
    }
  }

  // 绘制终点（红色）- 如果在视野内才显示
  const goalX = MAZE_SIZE - 2;
  const goalY = MAZE_SIZE - 2;
  if (manhattanDistance(goalX, goalY, playerX, playerY) <= FOG_RADIUS) {
    ctx.fillStyle = '#f00';
    ctx.fillRect(goalX * CELL_SIZE, goalY * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }

  // 绘制起点（绿色）- 始终在视野内
  ctx.fillStyle = '#0f0';
  ctx.fillRect(1 * CELL_SIZE, 1 * CELL_SIZE, CELL_SIZE, CELL_SIZE);

  // 绘制玩家（黄色方块，稍小一些，带圆角）
  const playerSize = CELL_SIZE - 4;
  const playerOffset = (CELL_SIZE - playerSize) / 2;
  const playerPx = playerX * CELL_SIZE + playerOffset;
  const playerPy = playerY * CELL_SIZE + playerOffset;
  ctx.fillStyle = '#ff0';

  // 使用 roundRect 绘制圆角矩形（如果支持）
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(playerPx, playerPy, playerSize, playerSize, 3);
    ctx.fill();
  } else {
    // 手动绘制圆角矩形
    drawRoundRect(ctx, playerPx, playerPy, playerSize, playerSize, 3);
  }
}

// ============================================================
// 手动绘制圆角矩形（兼容不支持 roundRect 的浏览器）
// ============================================================
function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
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