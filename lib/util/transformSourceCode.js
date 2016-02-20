'use strict';

var babel = require('babel-core'),
    sourceMaps = require('./sourceMaps'),
    cache = Object.create(null);

module.exports = function transformSourceCode(filename) {
    var babelOptions = {
            sourceMaps: true,
            modules: 'common',
            ast: false,
            stage: 4,
            auxiliaryCommentBefore: 'istanbul ignore next',
            nonStandard: true // jsx support
        },
        result;

    if (!cache[filename]) {
        cache[filename] = babel.transformFileSync(filename, babelOptions);
    }

    result = cache[filename];

    sourceMaps[filename] = result.map;

    return result.code;
};
