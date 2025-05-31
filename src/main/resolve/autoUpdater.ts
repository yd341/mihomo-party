import axios from 'axios'
import yaml from 'yaml'
import { app, shell } from 'electron'
import { getAppConfig, getControledMihomoConfig } from '../config'
import { dataDir, exeDir, exePath, isPortable, resourcesFilesDir } from '../utils/dirs'
import { copyFile, rm, writeFile, readFile } from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { createHash } from 'crypto'

export async function checkUpdate(): Promise<IAppVersion | undefined> {
  const { 'mixed-port': mixedPort = 7890 } = await getControledMihomoConfig()
  const { updateChannel = 'stable' } = await getAppConfig()
  let url = 'https://github.com/xishang0128/sparkle/releases/latest/download/latest.yml'
  if (updateChannel == 'beta') {
    url = 'https://github.com/xishang0128/sparkle/releases/download/pre-release/latest.yml'
  }
  const res = await axios.get(url, {
    headers: { 'Content-Type': 'application/octet-stream' },
    ...(mixedPort != 0 && {
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port: mixedPort
      }
    }),
    responseType: 'text'
  })
  const latest = yaml.parse(res.data, { merge: true }) as IAppVersion
  const currentVersion = app.getVersion()
  if (latest.version !== currentVersion) {
    return latest
  } else {
    return undefined
  }
}

export async function downloadAndInstallUpdate(version: string): Promise<void> {
  const { 'mixed-port': mixedPort = 7890 } = await getControledMihomoConfig()
  let releaseTag = version
  if (version.includes('beta')) {
    releaseTag = 'pre-release'
  }
  let baseUrl = `https://github.com/xishang0128/sparkle/releases/download/${releaseTag}/`
  const fileMap = {
    'win32-x64': `sparkle-windows-${version}-x64-setup.exe`,
    'win32-arm64': `sparkle-windows-${version}-arm64-setup.exe`,
    'darwin-x64': `sparkle-macos-${version}-x64.pkg`,
    'darwin-arm64': `sparkle-macos-${version}-arm64.pkg`
  }
  let file = fileMap[`${process.platform}-${process.arch}`]
  if (isPortable()) {
    file = file.replace('-setup.exe', '-portable.7z')
  }
  if (!file) {
    throw new Error('不支持自动更新，请手动下载更新')
  }

  const apiUrl = `https://api.github.com/repos/xishang0128/sparkle/releases/tags/${releaseTag}`
  const apiRequestConfig: any = {
    headers: { Accept: 'application/vnd.github.v3+json' },
    ...(mixedPort != 0 && {
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port: mixedPort
      }
    })
  }
  const releaseRes = await axios.get(apiUrl, apiRequestConfig)
  const assets: Array<{ name: string; digest?: string }> = releaseRes.data.assets || []
  const matchedAsset = assets.find((a) => a.name === file)
  if (!matchedAsset || !matchedAsset.digest) {
    throw new Error(`无法从 GitHub Release 中找到 "${file}" 对应的 SHA-256 信息`)
  }
  const expectedHash = matchedAsset.digest.split(':')[1].toLowerCase()

  try {
    if (!existsSync(path.join(dataDir(), file))) {
      const res = await axios.get(`${baseUrl}${file}`, {
        responseType: 'arraybuffer',
        ...(mixedPort != 0 && {
          proxy: {
            protocol: 'http',
            host: '127.0.0.1',
            port: mixedPort
          }
        }),
        headers: {
          'Content-Type': 'application/octet-stream'
        }
      })
      await writeFile(path.join(dataDir(), file), res.data)
    }

    const fileBuffer = await readFile(path.join(dataDir(), file))
    const hashSum = createHash('sha256')
    hashSum.update(fileBuffer)
    const localHash = hashSum.digest('hex').toLowerCase()
    if (localHash !== expectedHash) {
      await rm(path.join(dataDir(), file), { force: true })
      throw new Error(`SHA-256 校验失败：本地哈希 ${localHash} 与预期 ${expectedHash} 不符`)
    }

    if (file.endsWith('.exe')) {
      spawn(path.join(dataDir(), file), ['/S', '--force-run'], {
        detached: true,
        stdio: 'ignore'
      }).unref()
    }
    if (file.endsWith('.7z')) {
      await copyFile(path.join(resourcesFilesDir(), '7za.exe'), path.join(dataDir(), '7za.exe'))
      spawn(
        'cmd',
        [
          '/C',
          `"timeout /t 2 /nobreak >nul && "${path.join(dataDir(), '7za.exe')}" x -o"${exeDir()}" -y "${path.join(dataDir(), file)}" & start "" "${exePath()}""`
        ],
        {
          shell: true,
          detached: true
        }
      ).unref()
      app.quit()
    }
    if (file.endsWith('.pkg')) {
      try {
        const execPromise = promisify(exec)
        const shell = `installer -pkg ${path.join(dataDir(), file).replace(' ', '\\\\ ')} -target /`
        const command = `do shell script "${shell}" with administrator privileges`
        await execPromise(`osascript -e '${command}'`)
        app.relaunch()
        app.quit()
      } catch {
        shell.openPath(path.join(dataDir(), file))
      }
    }
  } catch (e) {
    await rm(path.join(dataDir(), file), { force: true })
    throw e
  }
}
