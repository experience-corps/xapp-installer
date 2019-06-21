/* eslint-disable max-len */
/* eslint-disable require-jsdoc */
const path = require('path-browserify');
const EventEmitter = require('events');
const request = require('request');
const csv = require('csvtojson');
const JSzip = require('jszip');

// resolves once window.ShowpadLib is defined
function ensureShowpadLibLoaded() {
  return new Promise((resolve, reject) => {
    if (typeof window.ShowpadLib === 'undefined') {
      setTimeout(() => {
        reject(new Error('Showpad lib load timed out'));
      }, 5000);
      window.onShowpadLibLoaded = () => {
        resolve();
      };
    } else {
      resolve();
    }
  });
}

function getApiConfig() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      reject(new Error('Showpad API config timed out'));
    }, 5000);
    window.ShowpadLib.getShowpadApi((data) => {
      if (data.error === null) {
        resolve(data);
      } else {
        reject(data.error);
      }
    });
  });
}

// returns a Promise and an EventEmitter
// second argument of 'progress' event is n.nn
function downloadFromUrl(url) {
  const emitter = new EventEmitter();
  let file = new Uint8Array();
  const promise = new Promise((resolve, reject) => {
    let contentLength = 1;
    let downloadedLength = 0;
    request.get(url, {encoding: null})
        .on('response', (data) => {
          contentLength = parseInt(data.headers['content-length']);
        })
        .on('data', (block) => {
          file = combineUint8Arrays(file, block);
          downloadedLength += block.length;
          emitter.emit('progress', downloadedLength / contentLength,
              ((downloadedLength / contentLength) * 100).toFixed(2));
        })
        .on('end', () => {
          emitter.emit('end');
          resolve(file);
        })
        .on('error', (err) => {
          emitter.emit('error', err);
          reject(err);
        });
  });
  return {
    promise,
    emitter,
  };
}

// takes a Uint8Array and returns a JSZip instance
function unzipFile(file) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-unused-vars
    (new JSzip()).loadAsync(file)
        .then((data) => {
          resolve(data);
        })
        .catch((err) => {
          reject(err);
        });
  });
}

function getDotShowpad(zipfile) {
  return new Promise((resolve, reject) => {
    const dotShowpad = {
      filename: '',
      contents: null,
    };
    let dotShowpadFound = false;
    zipfile.forEach(async (relativePath, file) => {
      const filename = path.basename(relativePath);
      const extension = path.extname(filename);
      if (extension === '.showpad') {
        dotShowpadFound = true;
        dotShowpad.filename = filename;
        dotShowpad.contents = await zipfile.file(relativePath)
            .async('uint8array');
        resolve(dotShowpad);
      }
    });
    if (dotShowpadFound === false) {
      reject(new Error('Couldn\'t find a .showpad file'));
    }
  });
};

function uint8ToString(uintArray) {
  const encodedString = String.fromCharCode.apply(null, uintArray);
  const decodedString = decodeURIComponent(escape(encodedString));
  return decodedString;
}

// used for config.json and manifest.json
function getDataFiles(zipfile) {
  return new Promise(async (resolve, reject) => {
    const filenames = Object.keys(zipfile.files);
    if (filenames.indexOf('config.json') !== -1
    && filenames.indexOf('manifest.json') !== -1) {
      try {
        const config = await zipfile.file('config.json')
            .async('uint8array');
        const manifest = await zipfile.file('manifest.json')
            .async('uint8array');
        resolve({
          config: JSON.parse(uint8ToString(config)),
          manifest: JSON.parse(uint8ToString(manifest)),
        });
      } catch (e) {
        reject(e);
      }
    } else {
      reject(new Error('.showpad file is corrupted'));
    }
  });
}

function getAsset(path, zipfile) {
  return new Promise((resolve, reject) => {
    zipfile.file(path).async('uint8array')
        .then((data) => {
          resolve(data);
        })
        .catch((err) => {
          reject(err);
        });
  });
}

function combineUint8Arrays(a, b) {
  const newArray = new Uint8Array(a.length + b.length);
  newArray.set(a, 0);
  newArray.set(b, a.length);
  return newArray;
}

function downloadBinaryFile(filename, buf) {
  const element = document.createElement('a');
  element.setAttribute('href', URL.createObjectURL(
      new Blob([buf], {type: 'application/octet-stream'})));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

function uploadAsset(name, contents, apiConfig) {
  console.log('uploading', name, contents);
  return new Promise((resolve, reject) => {
    const url = `${apiConfig.url}/api/v3/assets.json`;
    const formData = new FormData();
    formData.append('file', new Blob([contents]), name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${apiConfig.accessToken}`);
    xhr.onreadystatechange = function() {
      if (xhr.readyState == 4) {
        const json = JSON.parse(xhr.responseText);
        if (json.response && json.response.resourcetype === 'Ticket') {
          pollTicket(json.response.id, apiConfig).then((data) => {
            resolve(data);
          }).catch((err) => reject(err));
        }
      }
    };
    xhr.send(formData);
  });
};

function pollTicket(id, apiConfig) {
  return new Promise((resolve, reject) => {
    const url = `${apiConfig.url}/api/v3/tickets/${id}.json`;
    const config = {
      headers: {
        'Authorization': `Bearer ${apiConfig.accessToken}`,
      },
    };
    fetch(url, config)
        .then((response) => response.json())
        .then((json) => {
          if (json.response.status) {
            switch (json.response.status) {
              case 'completed':
                // File was processed
                if (json.response.asset && json.response.asset.id) {
                  resolve(json.response.asset);
                  // const assetId = json.response.asset.id;
                  // console.log('file processed with asset id: ' + assetId);
                  // File was processed
                } else {
                  // Something else failed
                  reject(new Error('Upload Failed'));
                }
                break;
              case 'queued':
              case 'processing':
                // Still processing, poll again in 2 seconds
                console.log('Polling...');
                setTimeout(() => {
                  pollTicket(id, apiConfig).then((data) => {
                    resolve(data);
                  }).catch((err) => reject(err));
                }, 2000);
                break;
              case 'failed':
                // File processing failed..
                reject(new Error('File processing Failed'));
                break;
            }
          }
        });
  });
}

function getAssetById(id, apiConfig) {
  return new Promise((resolve, reject) => {
    request.get({url: `${apiConfig.url}/api/v3/assets/${id}.json`,
      headers: {'Authorization': `Bearer ${apiConfig.accessToken}`}},
    (err, res, body) => {
      if (err) reject(err);
      try {
        body = JSON.parse(body);
      } catch (e) {
        reject(e);
      }
      resolve(body.response);
    });
  });
}

function uploadAllCsvAssets(csv, zipfile, apiConfig) {
  let key = {};
  let promises = [];
  return new Promise((resolve, reject) => {
    for (const line of csv) {
      const filename = line[1];
      console.log('looking for', filename);
      let file = null;
      for (const [f, c] of Object.entries(zipfile.files)) {
        if (path.basename(f) == filename) {
          file = c;
          break;
        }
      }
      if (file) {
        const p = file.async('uint8array')
            .then((data) => {
              return uploadAsset(filename, data, apiConfig);
            })
            .then((resp) => {
              return getAssetById(resp.id, apiConfig);
            }).then((asset) => {
              key[line[0]] = asset;
            })
            .catch((err) => {
              console.log(err);
            });
        promises.push(p);
      } else {
        console.error('couldn\'t find', filename, 'in zipfile');
      }
    }
    Promise.all(promises).then(() => {
      resolve(key);
    }); // wait for everything to finish
  });
}

function replaceIDs(subset, key) {
  if (typeof subset == 'object') {
    if (subset.value && Array.isArray(subset.value)
    && typeof subset.value[0] == 'string') {
      if (key[subset.value[0]]) {
        console.log('replacing', subset.value[0]);
        const id = key[subset.value[0]].id;
        subset.value[0] = id;
        subset.result = [];
        subset.result.push(id);
      } else {
        console.log('id not found in csv:', subset.value[0]);
        subset.value[0] = 'notfound';
      }
    }
    // eslint-disable-next-line guard-for-in
    for (const k in subset) {
      replaceIDs(subset[k], key);
    }
  }
}

function unpackCsv(zipfile) {
  return new Promise((resolve, reject) => {
    let found = false;
    for (const file of Object.keys(zipfile.files)) {
      if (path.basename(file) == 'showpad-export.csv') {
        found = true;
        zipfile.file(file).async('uint8array')
            .then((data) => {
              let parsedCsv = [];
              csv({output: 'csv'}).fromString(uint8ToString(data))
                  .then((csvRow) => {
                    parsedCsv = csvRow;
                    resolve(parsedCsv);
                  })
                  .catch((err) => {
                    reject(err);
                  });
            })
            .catch((err) => {
              reject(err);
            });
        break;
      }
    }
    if (!found) {
      reject(new Error('CSV not found in buildfiles'));
    }
  });
}

async function main(url) {
  await ensureShowpadLibLoaded();
  const apiConfig = await getApiConfig();
  console.log('Got API config from Showpad: ', apiConfig);
  console.log('Downloading package...');
  const {promise, emitter} = downloadFromUrl(url);
  emitter.on('end', () => console.log('Downloaded buildfile archive.'));
  const buildZip = await promise;
  const mainZip = await unzipFile(buildZip);
  const dotShowpad = await getDotShowpad(mainZip);
  const showpadZip = await unzipFile(dotShowpad.contents);
  const {config, manifest} = await getDataFiles(showpadZip);
  const csv = await unpackCsv(mainZip);
  console.log(mainZip, showpadZip);
  console.log(config, manifest);
  console.log(csv);
  const key = await uploadAllCsvAssets(csv, mainZip, apiConfig);
  config.assets = {};
  for (const [_, newAsset] of Object.entries(key)) {
    config.assets[newAsset.id] = newAsset;
  }
  console.log(key);
  console.log(config);
  replaceIDs(config.contents, key);
  console.log(config); // modified
  const oldManifestVers = manifest.version;
  const newManifestVers = oldManifestVers
    + Math.floor(Math.random() * 10000).toString();
  const newShowpadFileName = manifest.identifier + newManifestVers;
  manifest.version = newManifestVers;
  showpadZip.file('config.json', JSON.stringify(config));
  showpadZip.file('manifest.json', JSON.stringify(manifest));
  const newShowpad = await showpadZip.generateAsync({type: 'uint8array'});
  downloadBinaryFile(newShowpadFileName + '.showpad', newShowpad);
  //
}

// fortune :)
downloadFromUrl('https://cors-anywhere.herokuapp.com/http://yerkee.com/api/fortune')
    .promise
    .then((data) => {
      const fortune = JSON.parse(uint8ToString(data)).fortune;
      document.getElementById('fortune').textContent = fortune;
    })
    .catch((err) => console.log(err));

document.getElementById('goButton').onclick = function(event) {
  main(document.getElementById('urlInput').value).catch((err) => {
    console.log(err);
  });
};
