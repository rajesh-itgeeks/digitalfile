// utils/productHandler.js
const DigitalProduct = require('../models/digitalproduct.model');
const ShopifySession = require('../models/shopifysession.model');
const { deleteOldFileFromDO } = require('./s3');
const { setVariantAsDigitalInShopify, updateProductTagsInShopify } = require('./shopify');
const { getField } = require('./formParser');

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

async function saveDigitalProduct(existingId, data) {
  if (!existingId) return await DigitalProduct.create(data);
  return await DigitalProduct.findByIdAndUpdate(existingId, data, { new: true });
}

module.exports = { handleRemovedVariantDeletes, handleModeAndUploadDeletes, saveDigitalProduct };