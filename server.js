// server.js - Full Working Single Node.js File for Digital Product Uploader
// All fixes applied: formidable v3, parsing, S3 upload, Mongo save, Shopify integration
// Run with: node server.js (or nodemon server.js for dev)
// Dependencies: npm install express formidable@^3.5.1 aws-sdk graphql-request mongoose dotenv

require('dotenv').config();
const express = require('express');
const { formidable } = require('formidable');  // v3: Destructure formidable
const AWS = require('aws-sdk');
const { GraphQLClient, gql } = require('graphql-request');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log(`MongoDB Connected: ${mongoose.connection.host}`);
  } catch (error) {
    console.error('Error connecting to MongoDB:', error.message);
    process.exit(1);
  }
};
connectDB();

// Mongoose Models (Defined inline for single file)
const DigitalProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  productId: { type: String, required: true, unique: true },
  productImage: { type: String },
  status: { type: String },
  variants: [{
    id: { type: String, required: true },
    sku: { type: String },
    title: { type: String },
    image: { type: String },
    fileKey: { type: String },
    download: { type: Number, default: 0 },
    fileUrl: { type: String },
    fileName: { type: String },
    fileSize: { type: Number, default: 0 }
  }],
  fileType: { type: String },
  totalVariants: { type: Number, default: 1 }
}, { timestamps: true });
const DigitalProduct = mongoose.model('DigitalProduct', DigitalProductSchema);

const ShopifySessionSchema = new mongoose.Schema({
  shop: { type: String, required: true, unique: true },
  accessToken: { type: String, required: true }
}, { timestamps: true });
const ShopifySession = mongoose.model('ShopifySession', ShopifySessionSchema);

// S3 Setup (DigitalOcean Spaces)
const region = process.env.DO_SPACES_REGION || "nyc3";
const spacesEndpoint = new AWS.Endpoint(
  process.env.DO_SPACES_ENDPOINT || `https://${process.env.DO_SPACES_BUCKET_NAME || "your-space-name"}.${region}.digitaloceanspaces.com`
);
const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: region,
  s3ForcePathStyle: true,
});

// Utility Functions
function getField(fields, key) {
  const val = fields?.[key];
  if (Array.isArray(val)) return val[0];
  return val ?? undefined;
}

async function parseFormData(req) {
  const tmpDir = path.join(__dirname, 'tmp');

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
    // Debug: Log Content-Type
    console.log('🔍 Request Content-Type:', req.headers['content-type']);
    if (!req.headers['content-type'] || !req.headers['content-type'].includes('multipart/form-data')) {
      console.warn('⚠️ Request is not multipart/form-data. Fields/files will be empty.');
    }

    // v3: parse() returns [fields, files] array
    const [rawFields, rawFiles] = await form.parse(req);

    console.log('🔍 Parse result type for fields:', typeof rawFields);  // Debug
    console.log('🔍 Parse result type for files:', typeof rawFiles);  // Debug
    console.log('🔍 Raw fields keys:', Object.keys(rawFields));  // Debug
    console.log('🔍 Raw files keys:', Object.keys(rawFiles));  // Debug

    // Safety check: If undefined or empty, log and return empty
    if (!rawFields || Object.keys(rawFields).length === 0 || !rawFiles || Object.keys(rawFiles).length === 0) {
      console.warn('⚠️ No fields or files found in request. Ensure Content-Type: multipart/form-data');
      return { fields: {}, files: {} };
    }

    // Convert rawFields (plain object) to processed object (handle arrays)
    const fieldsObj = {};
    for (const [name, value] of Object.entries(rawFields)) {
      fieldsObj[name] = Array.isArray(value) ? value : [value];
    }

    // Handle files upload to S3 (rawFiles is plain object, values are arrays of file objects)
    const filesObj = {};
    const uploadPromises = [];

    for (const [name, fileArray] of Object.entries(rawFiles)) {
      console.log(`📁 Processing file field: ${name}, files count: ${fileArray.length}`);  // Debug
      fileArray.forEach((fileObj, index) => {
        if (fileObj && fileObj.filepath) {
          if (!fs.existsSync(fileObj.filepath)) {
            console.error(`⚠️ Temp file not found: ${fileObj.filepath}`);
            return;
          }

          const uploadPromise = uploadFileStreamToS3(name, fileObj, fieldsObj);
          uploadPromises.push(
            uploadPromise.then(result => {
              if (result) {
                if (!filesObj[name]) filesObj[name] = [];
                filesObj[name].push(result);
              }
            }).catch(err => {
              console.error(`Error uploading file ${name}[${index}]:`, err);
            })
          );
        }
      });
    }

    await Promise.all(uploadPromises);

    // Cleanup temp files
    for (const [name, fileArray] of Object.entries(rawFiles)) {
      fileArray.forEach(fileObj => {
        if (fileObj && fileObj.filepath && fs.existsSync(fileObj.filepath)) {
          fs.unlinkSync(fileObj.filepath);
          console.log(`🗑️ Cleaned up temp file: ${fileObj.filepath}`);
        }
      });
    }

    console.log('✅ Parsing complete. Fields count:', Object.keys(fieldsObj).length, 'Files count:', Object.keys(filesObj).length);  // Debug
    return { fields: fieldsObj, files: filesObj };
  } catch (error) {
    console.error('Form parse error:', error);
    throw error;
  }
}

async function uploadFileStreamToS3(fieldName, file, fields) {
  // Generate path based on fieldName (common or variant)
  const productDataStr = getField(fields, "productData") || '';

  let productData;
  try {
    productData = JSON.parse(productDataStr);
    console.log("✅ Product data parsed from fields:", productData.productId);
  } catch (e) {
    console.error("❌ Invalid productData in fields:", e);
    return null;  // Fail upload if no valid productData
  }

  const currentYearStr = new Date().getFullYear().toString();
  const monthStr = (new Date().getMonth() + 1).toString().padStart(2, "0");
  const cleanFileName = (file.originalFilename || 'unknown').replace(/\s+/g, "_");
  const numericId = productData?.productId?.split("/").pop() || 'unknown';

  let key;
  if (fieldName === 'file') {
    key = `private/wp-content/uploads/${currentYearStr}/${monthStr}/${numericId}/${cleanFileName}`;
  } else if (fieldName.startsWith('variantFiles[')) {
    const variantId = fieldName.match(/\[(.+)\]/)?.[1] || 'unknown';
    key = `private/wp-content/uploads/${currentYearStr}/${monthStr}/${numericId}/${cleanFileName}`;
  } else {
    return null;
  }

  console.log(`📁 Generated S3 key: ${key}`);

  const params = {
    Bucket: process.env.DO_SPACES_BUCKET_NAME,
    Key: key,
    Body: fs.createReadStream(file.filepath),
    ContentType: file.mimetype || "application/octet-stream",
    ACL: "private",
  };

  try {
    const uploadResult = await s3.upload(params).promise();
    console.log(`✅ Upload success for ${fieldName}: ${uploadResult.Key}`);
    return {
      key: uploadResult.Key,
      url: uploadResult.Location,
      name: cleanFileName,
      size: file.size || 0,
      type: fieldName === 'file' ? 'common' : 'variant',
      variantId: fieldName.match(/\[(.+)\]/)?.[1] || null
    };
  } catch (err) {
    console.error('S3 upload error:', err);
    return null;
  }
}

async function deleteOldFileFromDO(fileKey) {
  if (!fileKey) return;
  try {
    await s3.deleteObject({
      Bucket: process.env.DO_SPACES_BUCKET_NAME,
      Key: fileKey,
    }).promise();
    console.log("Old file deleted from DO:", fileKey);
  } catch (err) {
    console.warn("Failed to delete old file:", err.message || err);
  }
}

async function handleRemovedVariantDeletes(existingProduct, newVariants) {
  if (!existingProduct || !newVariants) return;

  const newVariantIds = new Set(newVariants.map(v => v.id));
  const removedVariants = existingProduct.variants.filter(oldV => !newVariantIds.has(oldV.id));

  console.log(`Found ${removedVariants.length} removed variants to clean up files for.`);
  for (const removedV of removedVariants) {
    if (removedV.fileKey) {
      await deleteOldFileFromDO(removedV.fileKey);
      console.log(`Deleted file for removed variant: ${removedV.id}`);
    }
  }
}

async function handleModeAndUploadDeletes(existingProduct, newMode, commonFile, variantFileMap) {
  if (!existingProduct) return;

  let oldMode = null;
  if (existingProduct.variants?.length > 0) {
    const firstKey = existingProduct.variants[0]?.fileKey;
    const allSame = existingProduct.variants.every(v => v.fileKey === firstKey);
    oldMode = allSame && firstKey ? "common" : "variant";
  }

  const oldKeys = new Set();
  existingProduct.variants.forEach(v => {
    if (v.fileKey) oldKeys.add(v.fileKey);
  });

  if (oldMode && oldMode !== newMode) {
    console.log("Switching file modes, deleting old files...");
    await Promise.all(Array.from(oldKeys).map(key => deleteOldFileFromDO(key)));
  } else if (oldMode === "common" && newMode === "common" && commonFile && commonFile.length > 0) {
    const oldKey = existingProduct.variants[0]?.fileKey;
    if (oldKey) {
      await deleteOldFileFromDO(oldKey);
    }
  } else if (oldMode === "variant" && newMode === "variant") {
    console.log("Same variant mode, deleting old files for updated variants...");
    for (const variant of variantFileMap) {
      const oldVariant = existingProduct.variants.find(v => v.id === variant.id);
      if (oldVariant?.fileKey) {
        await deleteOldFileFromDO(oldVariant.fileKey);
      }
    }
  }
}

async function setVariantAsDigitalInShopify(shopDomain, accessToken, productId, variantId) {
  const client = new GraphQLClient(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
  });

  const getInventoryItemIdQuery = gql`
    query getVariantInventory($variantId: ID!) {
      productVariant(id: $variantId) {
        inventoryItem { id }
      }
    }
  `;

  const inventoryData = await client.request(getInventoryItemIdQuery, { variantId });
  const inventoryItemId = inventoryData.productVariant?.inventoryItem?.id;
  if (!inventoryItemId) throw new Error(`No inventory item found for variant ${variantId}`);

  const updateInventoryMutation = gql`
    mutation updateInventoryItem($id: ID!, $requiresShipping: Boolean!) {
      inventoryItemUpdate(id: $id, input: { requiresShipping: $requiresShipping }) {
        inventoryItem { id requiresShipping }
        userErrors { field message }
      }
    }
  `;

  const result = await client.request(updateInventoryMutation, { id: inventoryItemId, requiresShipping: false });
  if (result.inventoryItemUpdate.userErrors?.length) {
    console.error("Shopify update errors:", result.inventoryItemUpdate.userErrors);
    return { status: false, errors: result.inventoryItemUpdate.userErrors };
  }

  console.log("Variant set as digital in Shopify");
  return { status: true };
}

async function saveDigitalProduct(existingId, data) {
  if (!existingId) return await DigitalProduct.create(data);
  return await DigitalProduct.findByIdAndUpdate(existingId, data, { new: true });
}

async function updateProductTagsInShopify(shopDomain, accessToken, productId, newTags = []) {
  if (!newTags.length) return { status: false, message: "No tags to update" };

  const client = new GraphQLClient(`https://${shopDomain}/admin/api/2025-01/graphql.json`, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  const getTagsQuery = gql`
    query getProductTags($id: ID!) {
      product(id: $id) {
        id
        tags
      }
    }
  `;

  const productData = await client.request(getTagsQuery, { id: productId });
  const currentTags = productData?.product?.tags || [];

  const updatedTags = Array.from(new Set([...currentTags, ...newTags]));

  const updateTagsMutation = gql`
    mutation updateProductTags($id: ID!, $tags: [String!]!) {
      productUpdate(input: { id: $id, tags: $tags }) {
        product { id tags }
        userErrors { field message }
      }
    }
  `;

  const result = await client.request(updateTagsMutation, { id: productId, tags: updatedTags });

  if (result.productUpdate.userErrors?.length) {
    console.error("Tag update errors:", result.productUpdate.userErrors);
    return { status: false, errors: result.productUpdate.userErrors };
  }

  console.log("✅ Product tags updated successfully:", updatedTags);
  return { status: true, tags: updatedTags };
}

// NO GLOBAL MIDDLEWARE - Handle everything inside routes

// Main Handler Route (Converted from Next.js default export)
app.post('/api/upload', async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { fields, files } = await parseFormData(req);
    const productDataStr = getField(fields, "productData");
    if (!productDataStr) {
      return res.status(400).json({ error: "Missing productData field" });
    }
    const productData = JSON.parse(productDataStr);
    const id = productData.id;

    const alreadyExists = await DigitalProduct.findOne({
      productId: productData.productId,
      _id: { $ne: id }
    });

    if (alreadyExists) {
      return res.status(400).json({ error: "Product already exists" });
    }
    
    let commonFile = null;
    let variantFileMap = [];

    if (files.file && files.file.length > 0) {
      commonFile = files.file.filter(f => f !== null); // Filter failed uploads if any
    }

    Object.keys(files).forEach(key => {
      const match = key.match(/^variantFiles\[(.*)\]$/);
      if (match) {
        const validFiles = files[key]?.filter(f => f !== null) || [];
        if (validFiles.length > 0) {
          let variantObj = {
            id: match[1],
            file : validFiles
          };
          variantFileMap.push(variantObj);
        }
      }
    });

    let existingProduct = null;
    let newMode = productData.productType === "commonFile" ? "common" : "variant";

    if (productData.id) {
      // Update mode
      existingProduct = await DigitalProduct.findById(productData.id);
      if (!existingProduct) throw new Error("Existing product not found");

      await handleRemovedVariantDeletes(existingProduct, productData.variants);

      await handleModeAndUploadDeletes(existingProduct, newMode, commonFile, variantFileMap);
      console.log("🔄 Update mode: Handled deletes for existing product");
    } else {
      // Add mode - no deletes needed
      console.log("➕ Add mode: Creating new digital product");
    }

    // Since uploads are done during parsing, doFile is now the uploaded metadata
    const doFile = commonFile || (variantFileMap.length > 0) ? { files: files, type: newMode } : null; // Adjust based on uploaded results

    let productObject = {
      name: productData.title,
      productId: productData.productId,
      productImage: productData.productImage,
      status: productData.status,
      variants: [],
      fileType: productData.productType,
      totalVariants: productData.totalVariants
    };

    for (let i = 0; i < productData.variants.length; i++) {
      const v = productData.variants[i];
      let fileKey, fileUrl, fileName, fileSize;

      if (productData.productType === "commonFile") {
        if (doFile && doFile.type === "common" && commonFile && commonFile.length > 0) {
          const commonUpload = commonFile[0]; // Adjust to match uploaded metadata
          fileKey = commonUpload.key;
          fileUrl = commonUpload.url;
          fileName = commonUpload.name;
          fileSize = commonUpload.size;
        } else {
          fileKey = v.fileKey || "";
          fileUrl = v.fileUrl || "";
          fileName = v.fileName || "";
          fileSize = v.fileSize || 0;
        }
      } else {
        // For variant mode, lookup from variantFileMap
        const variantUploadObj = variantFileMap.find(vm => vm.id === v.id);
        if (variantUploadObj && variantUploadObj.file && variantUploadObj.file.length > 0) {
          const newUpload = variantUploadObj.file[0];
          fileKey = newUpload.key;
          fileUrl = newUpload.url;
          fileName = newUpload.name;
          fileSize = newUpload.size;
        } else {
          fileKey = v.fileKey || "";
          fileUrl = v.fileUrl || "";
          fileName = v.fileName || "";
          fileSize = v.fileSize || 0;
        }
      }

      const variantObject = {
        id: v.id,
        sku: v.sku,
        title: productData.totalVariants == 1 ? productData.title : v.title,
        image: productData.totalVariants == 1 ? productData.productImage : v.image,
        fileKey,
        download: v.download || 0,
        fileUrl,
        fileName,
        fileSize,
      };
      productObject.variants.push(variantObject);
    }

    const productDataSave = await saveDigitalProduct(productData.id, productObject);
    if (!productDataSave) throw new Error("Failed to save digital product in mongo");

    const shop = process.env.SHOP_DOMAIN;
    const shopSession = await ShopifySession.findOne({ shop });
    if (shopSession) {
      try {
        for (let i = 0; i < productData.variants.length; i++) {
          await setVariantAsDigitalInShopify(shop, shopSession.accessToken, productData.productId, productData.variants[i].id);
        }

        const newTags = ["Digital Product"];
        await updateProductTagsInShopify(shopSession.shop, shopSession.accessToken, productData.productId, newTags);
      } catch (error) {
        console.warn("Shopify update failed :", error.message || error);
      }
    }

    const isUpdate = !!productData.id;
    const message = isUpdate ? "Product updated successfully" : "Product created successfully";
    console.log(`🎉 ${message}`);
    return res.status(200).json({ message, status: true });
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: error.message || "Internal server error" });
  }
});

// Test Route
app.get('/', (req, res) => {
  res.send('Digital Product Uploader API is running on Node.js!');
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});