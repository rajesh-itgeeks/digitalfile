const { formidable } = require('formidable');
const fs = require('fs');
const path = require('path');
const { uploadFileStreamToS3 } = require('./s3');

// getField function locally defined here
function getField(fields, key) {
  const val = fields?.[key];
  if (Array.isArray(val)) return val[0];
  return val ?? undefined;
}

async function parseFormData(req) {
  const tmpDir = path.join(__dirname, '../tmp');

  // Auto-create tmp dir if it doesn't exist
  try {
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      console.log(`📁 Created tmp directory: ${tmpDir}`);
    }
  } catch (err) {
    console.error('Error creating tmp dir:', err);
    throw new Error(`Failed to create temp directory: ${err.message}`);
  }

  const form = formidable({
    uploadDir: tmpDir,
    keepExtensions: true,
    multiples: true,
    maxFileSize: 1024 * 1024 * 1024 * 5,  // 5GB
    maxFieldsSize: 50 * 1024 * 1024,  // 50MB for fields
  });

  try {
    // v3: parse() returns { fields, files }
    const parseResult = await form.parse(req);
    const rawFields = parseResult.fields;
    const rawFiles = parseResult.files;

    // Safety check: If undefined, log and return empty
    if (!rawFields || !rawFiles) {
      console.warn('⚠️ No fields or files found in request. Ensure Content-Type: multipart/form-data');
      return { fields: {}, files: {} };
    }

    // Convert rawFields (Map) to plain object
    const fieldsObj = {};
    for (const [name, value] of rawFields.entries()) {
      if (Array.isArray(fieldsObj[name])) {
        fieldsObj[name].push(value);
      } else {
        fieldsObj[name] = [value];
      }
    }

    // Handle files upload to S3
    const filesObj = {};
    const uploadPromises = [];

    for (const [name, fileObj] of rawFiles.entries()) {
      if (fileObj && fileObj.filepath) {
        if (!fs.existsSync(fileObj.filepath)) {
          console.error(`⚠️ Temp file not found: ${fileObj.filepath}`);
          continue;
        }

        const uploadPromise = uploadFileStreamToS3(name, fileObj, fieldsObj);
        uploadPromises.push(
          uploadPromise.then(result => {
            if (result) {
              if (!filesObj[name]) filesObj[name] = [];
              filesObj[name].push(result);
            }
          }).catch(err => {
            console.error(`Error uploading file ${name}:`, err);
          })
        );
      }
    }

    await Promise.all(uploadPromises);

    // Cleanup temp files
    for (const fileObj of rawFiles.values()) {
      if (fileObj.filepath && fs.existsSync(fileObj.filepath)) {
        fs.unlinkSync(fileObj.filepath);
        console.log(`🗑️ Cleaned up temp file: ${fileObj.filepath}`);
      }
    }

    return { fields: fieldsObj, files: filesObj };
  } catch (error) {
    console.error('Form parse error:', error);
    throw error;
  }
}

module.exports = { parseFormData, getField };