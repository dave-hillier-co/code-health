const b = require("./b");
const { c } = require("./c");
require("./side");
const lazy = () => import("./b");

module.exports = { go() { b.x(); c(); lazy(); } };
