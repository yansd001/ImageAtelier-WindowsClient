const { app, BrowserWindow, shell } = require('electron')
const { existsSync } = require('node:fs')
const path = require('node:path')

const appRoot = path.join(__dirname, '..')
let mainWindow = null

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
}

function createWindow() {
  const iconPath = path.join(appRoot, 'dist', 'logo.png')
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return
    event.preventDefault()
    openExternal(url)
  })
  void mainWindow.loadFile(path.join(appRoot, 'dist', 'index.html'))
}

app.setAppUserModelId('io.github.yansd001.imageatelier')
app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
