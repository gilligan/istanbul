/*
 Copyright (c) 2012, Yahoo! Inc.  All rights reserved.
 Copyrights licensed under the New BSD License. See the accompanying LICENSE file for terms.
 */
"use strict";
var MemoryStore = require('./store/memory'),
    utils = require('./object-utils'),
    sourceMaps = require('./util/sourceMaps'),
    SourceMapConsumer = require('source-map').SourceMapConsumer;

/**
 * a mechanism to merge multiple coverage objects into one. Handles the use case
 * of overlapping coverage information for the same files in multiple coverage
 * objects and does not double-count in this situation. For example, if
 * you pass the same coverage object multiple times, the final merged object will be
 * no different that any of the objects passed in (except for execution counts).
 *
 * The `Collector` is built for scale to handle thousands of coverage objects.
 * By default, all processing is done in memory since the common use-case is of
 * one or a few coverage objects. You can work around memory
 * issues by passing in a `Store` implementation that stores temporary computations
 * on disk (the `tmp` store, for example).
 *
 * The `getFinalCoverage` method returns an object with merged coverage information
 * and is provided as a convenience for implementors working with coverage information
 * that can fit into memory. Reporters, in the interest of generality, should *not* use this method for
 * creating reports.
 *
 * Usage
 * -----
 *
 *      var collector = new require('istanbul').Collector();
 *
 *      files.forEach(function (f) {
 *          //each coverage object can have overlapping information about multiple files
 *          collector.add(JSON.parse(fs.readFileSync(f, 'utf8')));
 *      });
 *
 *      collector.files().forEach(function(file) {
 *          var fileCoverage = collector.fileCoverageFor(file);
 *          console.log('Coverage for ' + file + ' is:' + JSON.stringify(fileCoverage));
 *      });
 *
 *      // convenience method: do not use this when dealing with a large number of files
 *      var finalCoverage = collector.getFinalCoverage();
 *
 * @class Collector
 * @module main
 * @constructor
 * @param {Object} options Optional. Configuration options.
 * @param {Store} options.store - an implementation of `Store` to use for temporary
 *      calculations.
 */
function Collector(options) {
    options = options || {};
    this.store = options.store || new MemoryStore();
}

function translateCoverageItem(coverageProperty, sourceMapConsumer) {
    var remapped = {};

    Object.keys(coverageProperty).forEach(function (key) {
        var coverageItem = coverageProperty[key];

        if (coverageItem.start) {
            coverageItem.start = sourceMapConsumer.originalPositionFor(coverageItem.start);
        }

        if (coverageItem.end) {
            coverageItem.end = sourceMapConsumer.originalPositionFor(coverageItem.end);
        }

        if (coverageItem.loc) {
            coverageItem.loc = {
                start: sourceMapConsumer.originalPositionFor(coverageItem.loc.start),
                end: sourceMapConsumer.originalPositionFor(coverageItem.loc.end)
            };
        }

        if (coverageItem.line > 0) {
            coverageItem.line = sourceMapConsumer.originalPositionFor({ line: coverageItem.line, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND }).line;

        }

        if (coverageItem.locations) {
            coverageItem.locations = coverageItem.locations.map(function (loc) {
                var mapped = {
                    start: sourceMapConsumer.originalPositionFor(loc.start),
                    end: sourceMapConsumer.originalPositionFor(loc.end),
                };

                if (mapped.start.line === null) {
                    mapped = {
                        start: sourceMapConsumer.originalPositionFor({line: loc.start.line, column: loc.start.column - 1, bias: SourceMapConsumer.LEAST_UPPER_BOUND }),
                        end: sourceMapConsumer.originalPositionFor({line: loc.end.line, column: loc.end.column - 1, bias: SourceMapConsumer.LEAST_UPPER_BOUND })
                    };
                }

                if (loc.skip) {
                    mapped.skip = loc.skip;
                }

                return mapped;
            });
        }

        remapped[key] = coverageItem;
    });

    return remapped;
}

function skipUnresolveableCoverageItems(itemMap) {
    // babel transpiles some ES6 statements to multiple ES5 statements
    // without adding the auxiliary comment to the helper statements
    // therefore we have to manually skip statements where the original source location couldn’t be resolved

    Object.keys(itemMap).forEach(function (key) {
        var item = itemMap[key];

        if (!item.skip) {
            if (item.line === null || (item.start && item.start.line === null) || (item.loc && item.loc.start.line === null)) {
                item.skip = true;
            }
        }
    });
}

function translateCoverageObject(coverage) {
    var filename = coverage.path,
        sourceMap = sourceMaps[filename],
        consumer;

    if (!sourceMap) {
        return coverage;
    }

    consumer = new SourceMapConsumer(sourceMap);

    coverage.fnMap = translateCoverageItem(coverage.fnMap, consumer);
    coverage.branchMap = translateCoverageItem(coverage.branchMap, consumer);
    coverage.statementMap = translateCoverageItem(coverage.statementMap, consumer);

    skipUnresolveableCoverageItems(coverage.fnMap);
    skipUnresolveableCoverageItems(coverage.branchMap);
    skipUnresolveableCoverageItems(coverage.statementMap);

    return coverage;
}

Collector.prototype = {
    /**
     * adds a coverage object to the collector.
     *
     * @method add
     * @param {Object} coverage the coverage object.
     * @param {String} testName Optional. The name of the test used to produce the object.
     *      This is currently not used.
     */
    add: function (coverage /*, testName */) {
        var store = this.store;
        Object.keys(coverage).forEach(function (key) {
            var fileCoverage = coverage[key];

            if (store.hasKey(key)) {
                store.setObject(key, translateCoverageObject(utils.mergeFileCoverage(fileCoverage, store.getObject(key))));
            } else {
                store.setObject(key, translateCoverageObject(fileCoverage));
            }
        });
    },
    /**
     * returns a list of unique file paths for which coverage information has been added.
     * @method files
     * @return {Array} an array of file paths for which coverage information is present.
     */
    files: function () {
        return this.store.keys();
    },
    /**
     * return file coverage information for a single file
     * @method fileCoverageFor
     * @param {String} fileName the path for the file for which coverage information is
     *      required. Must be one of the values returned in the `files()` method.
     * @return {Object} the coverage information for the specified file.
     */
    fileCoverageFor: function (fileName) {
        var ret = this.store.getObject(fileName);
        utils.addDerivedInfoForFile(ret);
        return ret;
    },
    /**
     * returns file coverage information for all files. This has the same format as
     * any of the objects passed in to the `add` method. The number of keys in this
     * object will be a superset of all keys found in the objects passed to `add()`
     * @method getFinalCoverage
     * @return {Object} the merged coverage information
     */
    getFinalCoverage: function () {
        var ret = {},
            that = this;
        this.files().forEach(function (file) {
            ret[file] = that.fileCoverageFor(file);
        });
        return ret;
    },
    /**
     * disposes this collector and reclaims temporary resources used in the
     * computation. Calls `dispose()` on the underlying store.
     * @method dispose
     */
    dispose: function () {
        this.store.dispose();
    }
};

module.exports = Collector;
