require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { formidable } = require('formidable');  // v3: Destructure formidable
const AWS = require('aws-sdk');
const { GraphQLClient, gql } = require('graphql-request');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*', 
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

app.options('*', cors());

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
    console.log('🔍 Raw fields keys:', Object.keys(rawFields || {}));  // Debug
    console.log('🔍 Raw files keys:', Object.keys(rawFiles || {}));  // Debug

    // Safety check: If undefined or empty, log and return empty
    if (!rawFields || Object.keys(rawFields).length === 0) {
      console.warn('⚠️ No fields found in request. Ensure Content-Type: multipart/form-data and productData is appended.');
      return { fields: {}, files: {} };
    }

    // Convert rawFields (plain object) to processed object (handle arrays)
    const fieldsObj = {};
    for (const [name, value] of Object.entries(rawFields)) {
      fieldsObj[name] = Array.isArray(value) ? value : [value];
    }

    console.log('🔍 Parsed productData field:', getField(fieldsObj, 'productData') ? 'Present' : 'MISSING');  // Enhanced debug

    // Handle files upload to S3 only if files exist (rawFiles is plain object, values are arrays of file objects)
    const filesObj = {};
    const uploadPromises = [];

    if (rawFiles && Object.keys(rawFiles).length > 0) {
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
    } else {
      console.log('ℹ️ No files in request - proceeding with product data only');
    }

    // Cleanup temp files if any
    if (rawFiles) {
      for (const [name, fileArray] of Object.entries(rawFiles)) {
        fileArray.forEach(fileObj => {
          if (fileObj && fileObj.filepath && fs.existsSync(fileObj.filepath)) {
            fs.unlinkSync(fileObj.filepath);
            console.log(`🗑️ Cleaned up temp file: ${fileObj.filepath}`);
          }
        });
      }
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

async function updateVariantShippingInShopify(shopDomain, accessToken, productId, variantId, requiresShipping) {
  const action = requiresShipping ? 'physical (shipping on)' : 'digital (shipping off)';
  console.log(`🔄 Setting variant ${variantId} as ${action} for product ${productId} on shop ${shopDomain}`);
  const client = new GraphQLClient(`https://${shopDomain}/admin/api/2024-10/graphql.json`,
    {
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    }
  );

  const getInventoryItemIdQuery = gql`
    query getVariantInventory($variantId: ID!) {
      productVariant(id: $variantId) {
        id
        inventoryItem { id requiresShipping }
      }
    }
  `;

  try {
    const inventoryData = await client.request(getInventoryItemIdQuery, { variantId });
    const variant = inventoryData.productVariant;
    if (!variant) {
      console.warn(`⚠️ Variant not found: ${variantId}`);
      return { status: false, error: `Variant not found: ${variantId}` };
    }

    const inventoryItem = variant.inventoryItem;
    if (!inventoryItem || !inventoryItem.id) {
      console.warn(`⚠️ No inventory item found for variant ${variantId} (may already be ${action} or no inventory tracking)`);
      return { status: false, error: `No inventory item for variant ${variantId}` };
    }

    // If already matches the target, skip update
    if (inventoryItem.requiresShipping === requiresShipping) {
      console.log(`✅ Variant ${variantId} already set as ${action} (requiresShipping: ${requiresShipping})`);
      return { status: true };
    }

    const updateInventoryMutation = gql`
      mutation updateInventoryItem($id: ID!, $requiresShipping: Boolean!) {
        inventoryItemUpdate(id: $id, input: { requiresShipping: $requiresShipping }) {
          inventoryItem { id requiresShipping }
          userErrors { field message }
        }
      }
    `;

    const result = await client.request(updateInventoryMutation, { id: inventoryItem.id, requiresShipping });
    if (result.inventoryItemUpdate.userErrors?.length > 0) {
      console.error("Shopify update errors for variant:", result.inventoryItemUpdate.userErrors);
      return { status: false, errors: result.inventoryItemUpdate.userErrors };
    }

    console.log(`✅ Variant ${variantId} set as ${action} in Shopify`);
    return { status: true };
  } catch (error) {
    console.error(`❌ Error setting variant ${variantId} as ${action}:`, error.message);
    return { status: false, error: error.message };
  }
}

async function saveDigitalProduct(existingId, data) {
  if (!existingId) return await DigitalProduct.create(data);
  return await DigitalProduct.findByIdAndUpdate(existingId, data, { new: true });
}

async function updateProductTagsInShopify(shopDomain, accessToken, productId, newTags = []) {
  console.log(`🔄 Updating tags for product ${productId} on shop ${shopDomain} with new tags:`, newTags);
  if (!newTags.length) {
    console.warn('⚠️ No tags to update');
    return { status: false, message: "No tags to update" };
  }

  const client = new GraphQLClient(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {  // Fixed: Use 2024-10
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  // First, check if product exists
  const checkProductQuery = gql`
    query checkProduct($id: ID!) {
      product(id: $id) {
        id
        title
        tags
      }
    }
  `;

  try {
    const productCheck = await client.request(checkProductQuery, { id: productId });
    const product = productCheck?.product;
    if (!product) {
      console.error(`❌ Product not found: ${productId}`);
      return { status: false, error: `Product not found: ${productId}` };
    }

    console.log(`📋 Product found: ${product.title}, Current tags:`, product.tags || []);

    const currentTags = product.tags || [];
    const updatedTags = Array.from(new Set([...currentTags, ...newTags]));
    console.log(`📋 Updated tags:`, updatedTags);

    // If no change, skip update
    if (updatedTags.length === currentTags.length && updatedTags.every(tag => currentTags.includes(tag))) {
      console.log('ℹ️ No tag changes needed');
      return { status: true, tags: updatedTags };
    }

    const updateTagsMutation = gql`
      mutation updateProductTags($id: ID!, $tags: [String!]!) {
        productUpdate(input: { id: $id, tags: $tags }) {
          product { id tags }
          userErrors { field message }
        }
      }
    `;

    const result = await client.request(updateTagsMutation, { id: productId, tags: updatedTags });

    if (result.productUpdate.userErrors?.length > 0) {
      console.error("Tag update errors:", result.productUpdate.userErrors);
      return { status: false, errors: result.productUpdate.userErrors };
    }

    console.log("✅ Product tags updated successfully:", updatedTags);
    return { status: true, tags: updatedTags };
  } catch (error) {
    console.error(`❌ Error updating tags for ${productId}:`, error.message);
    return { status: false, error: error.message };
  }
}

// NO GLOBAL MIDDLEWARE - Handle everything inside routes

// Main Handler Route (Converted from Next.js default export)
app.post('/api/upload', async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { fields, files } = await parseFormData(req);
    const productDataStr = getField(fields, "productData");

    // Enhanced logging for missing productData
    if (!productDataStr) {
      console.error('❌ MISSING productData field! Full fields received:', Object.keys(fields));
      return res.status(400).json({ error: "Missing productData field. Ensure frontend appends JSON-stringified productData to FormData." });
    }

    console.log('✅ productData received and parsed. Keys:', Object.keys(JSON.parse(productDataStr)));
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

    // Handle files if present (no-file case: these will be null/empty)
    if (files.file && files.file.length > 0) {
      commonFile = files.file.filter(f => f !== null); // Filter failed uploads if any
      console.log(`📁 Common file(s) uploaded: ${commonFile.length}`);
    } else {
      console.log('ℹ️ No common file uploaded - using existing if update');
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
          console.log(`📁 Variant file for ${match[1]} uploaded: ${validFiles.length}`);
        }
      }
    });

    if (variantFileMap.length === 0) {
      console.log('ℹ️ No variant files uploaded - using existing if update');
    }

    let existingProduct = null;
    let newMode = productData.fileType === "commonFile" ? "common" : "variant";
    let oldMode = null;

    if (productData.id) {
      // Update mode
      existingProduct = await DigitalProduct.findById(productData.id);
      if (!existingProduct) throw new Error("Existing product not found");

      oldMode = existingProduct.fileType === "commonFile" ? "common" : "variant";
      console.log("🔄 Update mode: oldMode:", oldMode, "newMode:", newMode);
    } else {
      // Add mode - no deletes needed
      console.log("➕ Add mode: Creating new digital product");
    }

    // Handle mode switch migration if no new files
    let migratedCommonKey = null;
    let migratedCommonUrl = null;
    let migratedCommonName = null;
    let migratedCommonSize = null;

    if (existingProduct && oldMode && oldMode !== newMode) {
      const hasNewCommon = commonFile && commonFile.length > 0;
      const hasNewVariants = variantFileMap.some(vm => vm.file && vm.file.length > 0);
      const hasNewFiles = newMode === "common" ? hasNewCommon : hasNewVariants;

      if (!hasNewFiles) {
        console.log(`🔄 Migrating files for mode switch from ${oldMode} to ${newMode} without new uploads`);
        if (newMode === "common" && oldMode === "variant") {
          // Choose first variant with a file as the common file
          let chosenVariant = null;
          for (const ev of existingProduct.variants) {
            if (ev.fileKey) {
              chosenVariant = ev;
              break;
            }
          }
          if (chosenVariant) {
            migratedCommonKey = chosenVariant.fileKey;
            migratedCommonUrl = chosenVariant.fileUrl;
            migratedCommonName = chosenVariant.fileName;
            migratedCommonSize = chosenVariant.fileSize;
            console.log('📂 Migrated common file from variant:', chosenVariant.id);
          } else {
            console.warn('⚠️ No existing file to migrate for common mode');
          }
        } else if (newMode === "variant" && oldMode === "common") {
          // No special setup needed; handled in loop using existingProduct.variants[0]
          console.log('📂 Migrating common file to all variants');
        }
      }
    }

    let productObject = {
      name: productData.title,
      productId: productData.productId,
      productImage: productData.productImage,
      status: productData.status,
      variants: [],
      fileType: productData.fileType === "commonFile" ? "common" : "variant",
      totalVariants: productData.totalVariants
    };

    for (let i = 0; i < productData.variants.length; i++) {
      const v = productData.variants[i];
      let fileKey = v.fileKey || "";
      let fileUrl = v.fileUrl || "";
      let fileName = v.fileName || "";
      let fileSize = v.fileSize || 0;

      if (productData.fileType === "commonFile") {
        // Common file mode
        if (commonFile && commonFile.length > 0) {
          // New common file upload
          const commonUpload = commonFile[0];
          fileKey = commonUpload.key;
          fileUrl = commonUpload.url;
          fileName = commonUpload.name;
          fileSize = commonUpload.size;
          console.log(`📁 Using new common file for variant ${v.id}`);
        } else if (migratedCommonKey) {
          // Migrated from variant mode
          fileKey = migratedCommonKey;
          fileUrl = migratedCommonUrl;
          fileName = migratedCommonName;
          fileSize = migratedCommonSize;
          console.log(`📂 Using migrated common file for variant ${v.id}`);
        } else {
          // No change: use existing (from frontend or DB)
          const oldV = existingProduct?.variants.find(ev => ev.id === v.id) || existingProduct?.variants[0];
          fileKey = v.fileKey || oldV?.fileKey || "";
          fileUrl = v.fileUrl || oldV?.fileUrl || "";
          fileName = v.fileName || oldV?.fileName || "";
          fileSize = v.fileSize || oldV?.fileSize || 0;
          console.log(`ℹ️ Using existing common file for variant ${v.id}`);
        }
      } else {
        // Per-variant file mode
        const variantUploadObj = variantFileMap.find(vm => vm.id === v.id);
        if (variantUploadObj && variantUploadObj.file && variantUploadObj.file.length > 0) {
          // New variant file upload
          const newUpload = variantUploadObj.file[0];
          fileKey = newUpload.key;
          fileUrl = newUpload.url;
          fileName = newUpload.name;
          fileSize = newUpload.size;
          console.log(`📁 Using new variant file for ${v.id}`);
        } else if (existingProduct && oldMode === "common" && oldMode !== newMode) {
          // Migrated from common mode
          const oldCommonFile = existingProduct.variants[0];
          fileKey = oldCommonFile?.fileKey || v.fileKey || "";
          fileUrl = oldCommonFile?.fileUrl || v.fileUrl || "";
          fileName = oldCommonFile?.fileName || v.fileName || "";
          fileSize = oldCommonFile?.fileSize || v.fileSize || 0;
          console.log(`📂 Using migrated variant file (from common) for ${v.id}`);
        } else {
          // No change: use existing (from frontend or DB)
          const oldV = existingProduct?.variants?.find(ev => ev.id === v.id);
          fileKey = v.fileKey || oldV?.fileKey || "";
          fileUrl = v.fileUrl || oldV?.fileUrl || "";
          fileName = v.fileName || oldV?.fileName || "";
          fileSize = v.fileSize || oldV?.fileSize || 0;
          console.log(`ℹ️ Using existing variant file for ${v.id}`);
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

    console.log(`💾 Product saved/updated in Mongo: ${productDataSave._id}`);

    // Clean up unused old files (global: delete only if not referenced in new product)
    if (existingProduct) {
      const newFileKeys = new Set(productObject.variants.map(v => v.fileKey).filter(k => k));
      const oldFileKeys = new Set(existingProduct.variants.map(v => v.fileKey).filter(k => k));
      const toDelete = [...oldFileKeys].filter(key => !newFileKeys.has(key));
      console.log(`🗑️ Deleting ${toDelete.length} unused old files`);
      await Promise.all(toDelete.map(key => deleteOldFileFromDO(key)));
    }

    // Shopify Integration - Always attempt if session exists
    const shop = process.env.SHOP_DOMAIN;
    const shopSession = await ShopifySession.findOne({ shop });
    if (shopSession) {
      console.log(`🔗 Found Shopify session for ${shop}`);
      try {
        // Handle removed variants: Set shipping to true (physical)
        if (existingProduct && productData.id) {
          const newVariantIds = new Set(productObject.variants.map(v => v.id));
          const removedVariants = existingProduct.variants.filter(ev => !newVariantIds.has(ev.id));
          console.log(`🔄 Detected ${removedVariants.length} removed variants`);
          let revertSuccessCount = 0;
          for (const removedVariant of removedVariants) {
            const result = await updateVariantShippingInShopify(shopSession.shop, shopSession.accessToken, productData.productId, removedVariant.id, true);
            if (result.status) revertSuccessCount++;
          }
          console.log(`✅ ${revertSuccessCount}/${removedVariants.length} removed variants set as physical (shipping on)`);
        }

        // Set remaining variants as digital (shipping off)
        let digitalSuccessCount = 0;
        for (let i = 0; i < productData.variants.length; i++) {
          const result = await updateVariantShippingInShopify(shopSession.shop, shopSession.accessToken, productData.productId, productData.variants[i].id, false);
          if (result.status) digitalSuccessCount++;
        }
        console.log(`✅ ${digitalSuccessCount}/${productData.variants.length} variants set as digital`);

        // Update tags
        const newTags = ["Digital Product"];
        const tagResult = await updateProductTagsInShopify(shopSession.shop, shopSession.accessToken, productData.productId, newTags);
        if (tagResult.status) {
          console.log('✅ Tags updated successfully');
        } else {
          console.error('❌ Tags update failed:', tagResult);
        }
      } catch (error) {
        console.warn("Shopify integration failed :", error.message || error);
      }
    } else {
      console.warn(`⚠️ No Shopify session found for ${shop} - skipping Shopify updates`);
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