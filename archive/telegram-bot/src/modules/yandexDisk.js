const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const { URL } = require('url');
const config = require('../config');

class YandexDisk {
  constructor(fileManager) {
    this.fileManager = fileManager;
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

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', async () => {
          let obj = data ? JSON.parse(data) : null;
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
  async getUploadLink(userId, remotePath, overwrite = true) {
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
      
      return new Promise((resolve, reject) => {
        const options = {
          hostname: uploadUrl.hostname,
          port: 443,
          path: uploadUrl.pathname + uploadUrl.search,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream'
          }
        };

        const req = https.request(options, (res) => {
          if (res.statusCode === 201 || res.statusCode === 202) {
            // Delete local file after successful upload
            this.fileManager.deleteLocalFile(localFilePath);
            resolve(true);
          } else {
            reject(new Error(`Upload error: ${res.statusCode}`));
          }
        });

        req.on('error', (error) => {
          reject(error);
        });

        fileStream.pipe(req);
      });

    } catch (error) {
      console.error('Error uploading to Yandex Disk:', error);
      return false;
    }
  }

  /**
   * List files in folder
   */
  async listFiles(userId, folderPath) {
    try {
      const result = await this.request(userId, 'GET', this.resourceUrl, { 
        path: folderPath,
        limit: 1000 
      });

      if (result._embedded && result._embedded.items) {
        return result._embedded.items
          .filter(item => item.type === 'file')
          .map(item => item.name);
      }
      
      return [];
    } catch (error) {
      // If folder doesn't exist (404) or is empty, return empty array
      if (error.message.includes('404') || error.message.includes('DiskNotFoundError')) {
        return [];
      }
      throw error;
    }
  }

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
    return this.request(userId, 'GET', this.resourceUrl, { path: '/' });
  }
}

module.exports = YandexDisk;
