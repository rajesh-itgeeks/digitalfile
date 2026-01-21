// utils/shopify.js
const { GraphQLClient, gql } = require('graphql-request');

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

module.exports = { setVariantAsDigitalInShopify, updateProductTagsInShopify };