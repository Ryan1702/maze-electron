const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 780,
    resizable: false,
    title: 'Maze in the Fog',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 隐藏菜单栏
  Menu.setApplicationMenu(null);

  // 加载 index.html
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 禁止窗口标题被页面 <title> 覆盖
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});