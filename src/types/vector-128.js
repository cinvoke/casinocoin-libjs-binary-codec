const makeClass = require('../utils/make-class');
const {Hash128} = require('./hash-128');
const {ensureArrayLikeIs, SerializedType} = require('./serialized-type');

var Vector128 = makeClass({
  mixins: SerializedType,
  inherits: Array,
  statics: {
    fromParser: function fromParser(parser, hint) {
      var vector128 = new this();
      var bytes = hint !== null ? hint : parser.size() - parser.pos();
      var hashes = bytes / 32;
      for (var i = 0; i < hashes; i++) {
        vector128.push(Hash128.fromParser(parser));
      }
      return vector128;
    },
    from: function from(value) {
      return ensureArrayLikeIs(Vector128, value).withChildren(Hash128);
    } },

  toBytesSink: function toBytesSink(sink) {
    this.forEach(function (h) {return h.toBytesSink(sink);});
  },
  toJSON: function toJSON() {
    return this.map(function (hash) {return hash.toJSON();});
  } });


module.exports = {
  Vector128
};
