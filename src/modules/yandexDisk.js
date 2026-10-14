const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const { URL } = require('url');
const config = require('../config');

class YandexDisk {
  constructor(fileManager, transport = https) {
    this.fileManager = fileManager;
    this.transport = transport;
    this.apiHost = config.yandex.apiHost;
    this.resourceUrl = config.yandex.resourceUrl;
  }

  /**
   * Make request to Yandex Disk API
   */
  async request(userId, method, apiPath, query = null, fileStream = null) {
    const settings = this.fileManager.getUserSettings(userId);
    
    if (!settings.yandexToken) {
      throw new Error('OAuth token not set. Please configure authorization.');
    }

    return new Promise((resolve, reject) => {
      let url = apiPath;
      if (query) {
        const qs = querystring.stringify(query);
        url = `${apiPath}?${qs}`;
      }

      const headers = {
        'Authorization': `OAuth ${settings.yandexToken}`,
        'Content-Type': 'application/json'
      };

      const options = {
        hostname: this.apiHost,
        port: 443,
        path: url,
        method: method,
        headers: headers
      };

      const req = this.transport.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          let obj;
          try { obj = data ? JSON.parse(data) : null; } catch { reject(new Error(`Invalid API response: HTTP ${res.statusCode}`)); return; }
          const status = res.statusCode;

          // Handle redirect for upload
          if (status === 201 && obj && obj.href) {
            try {
              const result = await this.request(userId, obj.method, obj.href);
              resolve(result);
            } catch (error) {
              reject(error);
            }
            return;
          }

          if (status >= 400) {
            // Don't treat 409 as fatal error when creating folders
            if (method === 'PUT' && status === 409) {
              resolve({ error: 'Already exists', status });
              return;
            }
            
            reject(new Error(`Yandex Disk Error: ${status} - ${data}`));
            return;
          }

          resolve(obj);
        });
      });

      req.setTimeout(30000, () => req.destroy(new Error('Yandex request timeout')));
      req.on('error', (error) => {
        reject(error);
      });

      if (fileStream) {
        fileStream.pipe(req);
      } else {
        req.end();
      }
    });
  }

  /**
   * Ensure path exists on Yandex Disk (create if needed)
   */
  async ensurePath(userId, folderPath) {
    const parts = folderPath.split('/').filter(part => part.length > 0);
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      currentPath += '/' + parts[i];
      
      try {
        await this.request(userId, 'PUT', this.resourceUrl, { path: currentPath });
        console.log(`Created folder: ${currentPath}`);
      } catch (error) {
        // If folder already exists (409), ignore
        if (error.message.includes('409')) {
          console.log(`Folder already exists: ${currentPath}`);
          continue;
        }
        throw error;
      }
    }

    return true;
  }

  /**
   * Get upload link for file
   */
  async getUploadLink(userId, remotePath, overwrite = false) {
    return this.request(userId, 'GET', `${this.resourceUrl}/upload`, { 
      path: remotePath, 
      overwrite: overwrite.toString() 
    });
  }

  /**
   * Upload file to Yandex Disk
   */
  async uploadFile(userId, localFilePath, remoteFilePath) {
    try {
      // After a lost response, reconcile using exact bytes; never overwrite another report.
      const crypto = require('node:crypto');
      const hash = crypto.createHash('md5');
      for await (const chunk of fs.createReadStream(localFilePath)) hash.update(chunk);
      const md5 = hash.digest('hex');
      try {
        const remote = await this.request(userId, 'GET', this.resourceUrl, { path: remoteFilePath });
        if (remote.md5 === md5 && remote.size === fs.statSync(localFilePath).size) return true;
        throw new Error('Конфликт: файл с таким именем уже существует и имеет другое содержимое');
      } catch (error) {
        if (!error.message.includes('404')) throw error;
      }
      // Ensure folder path exists
      const lastSlashIndex = remoteFilePath.lastIndexOf('/');
      const folderPath = remoteFilePath.substring(0, lastSlashIndex);
      
      await this.ensurePath(userId, folderPath);

      // Get upload link
      const uploadData = await this.getUploadLink(userId, remoteFilePath);
      
      if (!uploadData.href) {
        throw new Error('Failed to get upload link');
      }

      // Upload file
      const fileStream = fs.createReadStream(localFilePath);
      const uploadUrl = new URL(uploadData.href);
      
      await new Promise((resolve, reject) => {
        const options = {
          hostname: uploadUrl.hostname,
          port: 443,
          path: uploadUrl.pathname + uploadUrl.search,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          }
        };

        const req = this.transport.request(options, (res) => {
          res.resume();
          if (res.statusCode === 201 || res.statusCode === 202) {
            // Local deletion belongs to the queue after its durable confirmation.
            resolve(true);
          } else {
            reject(new Error(`Upload error: ${res.statusCode}`));
          }
        });

        req.setTimeout(60000, () => req.destroy(new Error('Upload timeout')));
        fileStream.on('error', error => req.destroy(error));
        req.on('error', (error) => {
          reject(error);
        });

        fileStream.pipe(req);
      });
      const confirmed = await this.request(userId, 'GET', this.resourceUrl, { path: remoteFilePath });
      if (confirmed.md5 !== md5 || confirmed.size !== fs.statSync(localFilePath).size) throw new Error('Содержимое загрузки ещё не подтверждено');
      return true;

    } catch (error) {
      throw error;
    }
  }

  /**
   * List files in folder
   */
  async listEntries(userId, folderPath) {
    const items = [];
    for (let offset = 0; ; offset += 1000) {
      let result;
      try { result = await this.request(userId, 'GET', this.resourceUrl, { path: folderPath, limit: 1000, offset }); }
      catch (error) { if (error.message.includes('404')) return []; throw error; }
      const page = result?._embedded?.items || [];
      items.push(...page);
      if (page.length < 1000) break;
    }
    return items;
  }
  async listFiles(userId, folderPath) { return (await this.listEntries(userId, folderPath)).filter(e => e.type === 'file').map(e => e.name); }
  async listFolders(userId, folderPath) { return (await this.listEntries(userId, folderPath)).filter(e => e.type === 'dir').map(e => e.name); }

  /**
   * Delete file or folder
   */
  async delete(userId, path) {
    return this.request(userId, 'DELETE', this.resourceUrl, { path });
  }

  /**
   * Get disk info
   */
  async getDiskInfo(userId) {
    return this.request(userId, 'GET', '/v1/disk');
  }
}

module.exports = YandexDisk;
