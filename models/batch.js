const mongoose = require("mongoose");

const batchSchema = new mongoose.Schema({
  id: Number,
  records: Array,
  tags: Array,
  created_at: { type: Date, default: new Date() },
  completed_at: { type: Date, default: new Date() }
});

module.exports = mongoose.model("batch", batchSchema);
