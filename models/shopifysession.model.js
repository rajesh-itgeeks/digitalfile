const mongoose = require('mongoose');

const ShopifySessionSchema = new mongoose.Schema({
  shop: { type: String, required: true, unique: true },
  accessToken: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('ShopifySession', ShopifySessionSchema);