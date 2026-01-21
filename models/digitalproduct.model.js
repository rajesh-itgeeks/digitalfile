// models/digitalproduct.model.js
const mongoose = require('mongoose');

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
  fileType: { type: String }, // e.g., "commonFile"
  totalVariants: { type: Number, default: 1 }
}, { timestamps: true });

module.exports = mongoose.model('DigitalProduct', DigitalProductSchema);