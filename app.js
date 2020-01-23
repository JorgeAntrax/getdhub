const $select = document.querySelector.bind(document);
const $selectId = document.getElementById.bind(document);
const $all = document.querySelectorAll.bind(document);
const $log = console.log;

/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the W3C SOFTWARE AND DOCUMENT NOTICE AND LICENSE.
 *
 *  https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document
 *
 */
(function() {

// Exit early if we're not running in a browser.
    if (typeof window !== 'object') {
        return;
    }
// Exit early if all IntersectionObserver and IntersectionObserverEntry
// features are natively supported.
    if ('IntersectionObserver' in window &&
        'IntersectionObserverEntry' in window &&
        'intersectionRatio' in window.IntersectionObserverEntry.prototype) {
        // Minimal polyfill for Edge 15's lack of `isIntersecting`
        // See: https://github.com/w3c/IntersectionObserver/issues/211
        if (!('isIntersecting' in window.IntersectionObserverEntry.prototype)) {
            Object.defineProperty(window.IntersectionObserverEntry.prototype,
                'isIntersecting', {
                    get: function () {
                        return this.intersectionRatio > 0;
                    }
                });
        }
        return;
    }
    /**
     * A local reference to the document.
     */
    var document = window.document;
    /**
     * An IntersectionObserver registry. This registry exists to hold a strong
     * reference to IntersectionObserver instances currently observing a target
     * element. Without this registry, instances without another reference may be
     * garbage collected.
     */
    var registry = [];
    /**
     * Creates the global IntersectionObserverEntry constructor.
     * https://w3c.github.io/IntersectionObserver/#intersection-observer-entry
     * @param {Object} entry A dictionary of instance properties.
     * @constructor
     */
    function IntersectionObserverEntry(entry) {
        this.time = entry.time;
        this.target = entry.target;
        this.rootBounds = entry.rootBounds;
        this.boundingClientRect = entry.boundingClientRect;
        this.intersectionRect = entry.intersectionRect || getEmptyRect();
        this.isIntersecting = !!entry.intersectionRect;
        // Calculates the intersection ratio.
        var targetRect = this.boundingClientRect;
        var targetArea = targetRect.width * targetRect.height;
        var intersectionRect = this.intersectionRect;
        var intersectionArea = intersectionRect.width * intersectionRect.height;
        // Sets intersection ratio.
        if (targetArea) {
            // Round the intersection ratio to avoid floating point math issues:
            // https://github.com/w3c/IntersectionObserver/issues/324
            this.intersectionRatio = Number((intersectionArea / targetArea).toFixed(4));
        } else {
            // If area is zero and is intersecting, sets to 1, otherwise to 0
            this.intersectionRatio = this.isIntersecting ? 1 : 0;
        }
    }
    /**
     * Creates the global IntersectionObserver constructor.
     * https://w3c.github.io/IntersectionObserver/#intersection-observer-interface
     * @param {Function} callback The function to be invoked after intersection
     *     changes have queued. The function is not invoked if the queue has
     *     been emptied by calling the `takeRecords` method.
     * @param {Object=} opt_options Optional configuration options.
     * @constructor
     */
    function IntersectionObserver(callback, opt_options) {
        var options = opt_options || {};
        if (typeof callback != 'function') {
            throw new Error('callback must be a function');
        }
        if (options.root && options.root.nodeType != 1) {
            throw new Error('root must be an Element');
        }
        // Binds and throttles `this._checkForIntersections`.
        this._checkForIntersections = throttle(
            this._checkForIntersections.bind(this), this.THROTTLE_TIMEOUT);
        // Private properties.
        this._callback = callback;
        this._observationTargets = [];
        this._queuedEntries = [];
        this._rootMarginValues = this._parseRootMargin(options.rootMargin);
        // Public properties.
        this.thresholds = this._initThresholds(options.threshold);
        this.root = options.root || null;
        this.rootMargin = this._rootMarginValues.map(function(margin) {
            return margin.value + margin.unit;
        }).join(' ');
    }
    /**
     * The minimum interval within which the document will be checked for
     * intersection changes.
     */
    IntersectionObserver.prototype.THROTTLE_TIMEOUT = 100;
    /**
     * The frequency in which the polyfill polls for intersection changes.
     * this can be updated on a per instance basis and must be set prior to
     * calling `observe` on the first target.
     */
    IntersectionObserver.prototype.POLL_INTERVAL = null;
    /**
     * Use a mutation observer on the root element
     * to detect intersection changes.
     */
    IntersectionObserver.prototype.USE_MUTATION_OBSERVER = true;
    /**
     * Starts observing a target element for intersection changes based on
     * the thresholds values.
     * @param {Element} target The DOM element to observe.
     */
    IntersectionObserver.prototype.observe = function(target) {
        var isTargetAlreadyObserved = this._observationTargets.some(function(item) {
            return item.element == target;
        });
        if (isTargetAlreadyObserved) {
            return;
        }
        if (!(target && target.nodeType == 1)) {
            throw new Error('target must be an Element');
        }
        this._registerInstance();
        this._observationTargets.push({element: target, entry: null});
        this._monitorIntersections();
        this._checkForIntersections();
    };
    /**
     * Stops observing a target element for intersection changes.
     * @param {Element} target The DOM element to observe.
     */
    IntersectionObserver.prototype.unobserve = function(target) {
        this._observationTargets =
            this._observationTargets.filter(function(item) {
                return item.element != target;
            });
        if (!this._observationTargets.length) {
            this._unmonitorIntersections();
            this._unregisterInstance();
        }
    };
    /**
     * Stops observing all target elements for intersection changes.
     */
    IntersectionObserver.prototype.disconnect = function() {
        this._observationTargets = [];
        this._unmonitorIntersections();
        this._unregisterInstance();
    };
    /**
     * Returns any queue entries that have not yet been reported to the
     * callback and clears the queue. This can be used in conjunction with the
     * callback to obtain the absolute most up-to-date intersection information.
     * @return {Array} The currently queued entries.
     */
    IntersectionObserver.prototype.takeRecords = function() {
        var records = this._queuedEntries.slice();
        this._queuedEntries = [];
        return records;
    };
    /**
     * Accepts the threshold value from the user configuration object and
     * returns a sorted array of unique threshold values. If a value is not
     * between 0 and 1 and error is thrown.
     * @private
     * @param {Array|number=} opt_threshold An optional threshold value or
     *     a list of threshold values, defaulting to [0].
     * @return {Array} A sorted list of unique and valid threshold values.
     */
    IntersectionObserver.prototype._initThresholds = function(opt_threshold) {
        var threshold = opt_threshold || [0];
        if (!Array.isArray(threshold)) threshold = [threshold];
        return threshold.sort().filter(function(t, i, a) {
            if (typeof t != 'number' || isNaN(t) || t < 0 || t > 1) {
                throw new Error('threshold must be a number between 0 and 1 inclusively');
            }
            return t !== a[i - 1];
        });
    };
    /**
     * Accepts the rootMargin value from the user configuration object
     * and returns an array of the four margin values as an object containing
     * the value and unit properties. If any of the values are not properly
     * formatted or use a unit other than px or %, and error is thrown.
     * @private
     * @param {string=} opt_rootMargin An optional rootMargin value,
     *     defaulting to '0px'.
     * @return {Array<Object>} An array of margin objects with the keys
     *     value and unit.
     */
    IntersectionObserver.prototype._parseRootMargin = function(opt_rootMargin) {
        var marginString = opt_rootMargin || '0px';
        var margins = marginString.split(/\s+/).map(function(margin) {
            var parts = /^(-?\d*\.?\d+)(px|%)$/.exec(margin);
            if (!parts) {
                throw new Error('rootMargin must be specified in pixels or percent');
            }
            return {value: parseFloat(parts[1]), unit: parts[2]};
        });
        // Handles shorthand.
        margins[1] = margins[1] || margins[0];
        margins[2] = margins[2] || margins[0];
        margins[3] = margins[3] || margins[1];
        return margins;
    };
    /**
     * Starts polling for intersection changes if the polling is not already
     * happening, and if the page's visibility state is visible.
     * @private
     */
    IntersectionObserver.prototype._monitorIntersections = function() {
        if (!this._monitoringIntersections) {
            this._monitoringIntersections = true;
            // If a poll interval is set, use polling instead of listening to
            // resize and scroll events or DOM mutations.
            if (this.POLL_INTERVAL) {
                this._monitoringInterval = setInterval(
                    this._checkForIntersections, this.POLL_INTERVAL);
            }
            else {
                addEvent(window, 'resize', this._checkForIntersections, true);
                addEvent(document, 'scroll', this._checkForIntersections, true);
                if (this.USE_MUTATION_OBSERVER && 'MutationObserver' in window) {
                    this._domObserver = new MutationObserver(this._checkForIntersections);
                    this._domObserver.observe(document, {
                        attributes: true,
                        childList: true,
                        characterData: true,
                        subtree: true
                    });
                }
            }
        }
    };
    /**
     * Stops polling for intersection changes.
     * @private
     */
    IntersectionObserver.prototype._unmonitorIntersections = function() {
        if (this._monitoringIntersections) {
            this._monitoringIntersections = false;
            clearInterval(this._monitoringInterval);
            this._monitoringInterval = null;
            removeEvent(window, 'resize', this._checkForIntersections, true);
            removeEvent(document, 'scroll', this._checkForIntersections, true);
            if (this._domObserver) {
                this._domObserver.disconnect();
                this._domObserver = null;
            }
        }
    };
    /**
     * Scans each observation target for intersection changes and adds them
     * to the internal entries queue. If new entries are found, it
     * schedules the callback to be invoked.
     * @private
     */
    IntersectionObserver.prototype._checkForIntersections = function() {
        var rootIsInDom = this._rootIsInDom();
        var rootRect = rootIsInDom ? this._getRootRect() : getEmptyRect();
        this._observationTargets.forEach(function(item) {
            var target = item.element;
            var targetRect = getBoundingClientRect(target);
            var rootContainsTarget = this._rootContainsTarget(target);
            var oldEntry = item.entry;
            var intersectionRect = rootIsInDom && rootContainsTarget &&
                this._computeTargetAndRootIntersection(target, rootRect);
            var newEntry = item.entry = new IntersectionObserverEntry({
                time: now(),
                target: target,
                boundingClientRect: targetRect,
                rootBounds: rootRect,
                intersectionRect: intersectionRect
            });
            if (!oldEntry) {
                this._queuedEntries.push(newEntry);
            } else if (rootIsInDom && rootContainsTarget) {
                // If the new entry intersection ratio has crossed any of the
                // thresholds, add a new entry.
                if (this._hasCrossedThreshold(oldEntry, newEntry)) {
                    this._queuedEntries.push(newEntry);
                }
            } else {
                // If the root is not in the DOM or target is not contained within
                // root but the previous entry for this target had an intersection,
                // add a new record indicating removal.
                if (oldEntry && oldEntry.isIntersecting) {
                    this._queuedEntries.push(newEntry);
                }
            }
        }, this);
        if (this._queuedEntries.length) {
            this._callback(this.takeRecords(), this);
        }
    };
    /**
     * Accepts a target and root rect computes the intersection between then
     * following the algorithm in the spec.
     * TODO(philipwalton): at this time clip-path is not considered.
     * https://w3c.github.io/IntersectionObserver/#calculate-intersection-rect-algo
     * @param {Element} target The target DOM element
     * @param {Object} rootRect The bounding rect of the root after being
     *     expanded by the rootMargin value.
     * @return {?Object} The final intersection rect object or undefined if no
     *     intersection is found.
     * @private
     */
    IntersectionObserver.prototype._computeTargetAndRootIntersection =
        function(target, rootRect) {
            // If the element isn't displayed, an intersection can't happen.
            if (window.getComputedStyle(target).display == 'none') return;
            var targetRect = getBoundingClientRect(target);
            var intersectionRect = targetRect;
            var parent = getParentNode(target);
            var atRoot = false;
            while (!atRoot) {
                var parentRect = null;
                var parentComputedStyle = parent.nodeType == 1 ?
                    window.getComputedStyle(parent) : {};
                // If the parent isn't displayed, an intersection can't happen.
                if (parentComputedStyle.display == 'none') return;
                if (parent == this.root || parent == document) {
                    atRoot = true;
                    parentRect = rootRect;
                } else {
                    // If the element has a non-visible overflow, and it's not the <body>
                    // or <html> element, update the intersection rect.
                    // Note: <body> and <html> cannot be clipped to a rect that's not also
                    // the document rect, so no need to compute a new intersection.
                    if (parent != document.body &&
                        parent != document.documentElement &&
                        parentComputedStyle.overflow != 'visible') {
                        parentRect = getBoundingClientRect(parent);
                    }
                }
                // If either of the above conditionals set a new parentRect,
                // calculate new intersection data.
                if (parentRect) {
                    intersectionRect = computeRectIntersection(parentRect, intersectionRect);
                    if (!intersectionRect) break;
                }
                parent = getParentNode(parent);
            }
            return intersectionRect;
        };
    /**
     * Returns the root rect after being expanded by the rootMargin value.
     * @return {Object} The expanded root rect.
     * @private
     */
    IntersectionObserver.prototype._getRootRect = function() {
        var rootRect;
        if (this.root) {
            rootRect = getBoundingClientRect(this.root);
        } else {
            // Use <html>/<body> instead of window since scroll bars affect size.
            var html = document.documentElement;
            var body = document.body;
            rootRect = {
                top: 0,
                left: 0,
                right: html.clientWidth || body.clientWidth,
                width: html.clientWidth || body.clientWidth,
                bottom: html.clientHeight || body.clientHeight,
                height: html.clientHeight || body.clientHeight
            };
        }
        return this._expandRectByRootMargin(rootRect);
    };
    /**
     * Accepts a rect and expands it by the rootMargin value.
     * @param {Object} rect The rect object to expand.
     * @return {Object} The expanded rect.
     * @private
     */
    IntersectionObserver.prototype._expandRectByRootMargin = function(rect) {
        var margins = this._rootMarginValues.map(function(margin, i) {
            return margin.unit == 'px' ? margin.value :
                margin.value * (i % 2 ? rect.width : rect.height) / 100;
        });
        var newRect = {
            top: rect.top - margins[0],
            right: rect.right + margins[1],
            bottom: rect.bottom + margins[2],
            left: rect.left - margins[3]
        };
        newRect.width = newRect.right - newRect.left;
        newRect.height = newRect.bottom - newRect.top;
        return newRect;
    };
    /**
     * Accepts an old and new entry and returns true if at least one of the
     * threshold values has been crossed.
     * @param {?IntersectionObserverEntry} oldEntry The previous entry for a
     *    particular target element or null if no previous entry exists.
     * @param {IntersectionObserverEntry} newEntry The current entry for a
     *    particular target element.
     * @return {boolean} Returns true if a any threshold has been crossed.
     * @private
     */
    IntersectionObserver.prototype._hasCrossedThreshold =
        function(oldEntry, newEntry) {
            // To make comparing easier, an entry that has a ratio of 0
            // but does not actually intersect is given a value of -1
            var oldRatio = oldEntry && oldEntry.isIntersecting ?
                oldEntry.intersectionRatio || 0 : -1;
            var newRatio = newEntry.isIntersecting ?
                newEntry.intersectionRatio || 0 : -1;
            // Ignore unchanged ratios
            if (oldRatio === newRatio) return;
            for (var i = 0; i < this.thresholds.length; i++) {
                var threshold = this.thresholds[i];
                // Return true if an entry matches a threshold or if the new ratio
                // and the old ratio are on the opposite sides of a threshold.
                if (threshold == oldRatio || threshold == newRatio ||
                    threshold < oldRatio !== threshold < newRatio) {
                    return true;
                }
            }
        };
    /**
     * Returns whether or not the root element is an element and is in the DOM.
     * @return {boolean} True if the root element is an element and is in the DOM.
     * @private
     */
    IntersectionObserver.prototype._rootIsInDom = function() {
        return !this.root || containsDeep(document, this.root);
    };
    /**
     * Returns whether or not the target element is a child of root.
     * @param {Element} target The target element to check.
     * @return {boolean} True if the target element is a child of root.
     * @private
     */
    IntersectionObserver.prototype._rootContainsTarget = function(target) {
        return containsDeep(this.root || document, target);
    };
    /**
     * Adds the instance to the global IntersectionObserver registry if it isn't
     * already present.
     * @private
     */
    IntersectionObserver.prototype._registerInstance = function() {
        if (registry.indexOf(this) < 0) {
            registry.push(this);
        }
    };
    /**
     * Removes the instance from the global IntersectionObserver registry.
     * @private
     */
    IntersectionObserver.prototype._unregisterInstance = function() {
        var index = registry.indexOf(this);
        if (index != -1) registry.splice(index, 1);
    };
    /**
     * Returns the result of the performance.now() method or null in browsers
     * that don't support the API.
     * @return {number} The elapsed time since the page was requested.
     */
    function now() {
        return window.performance && performance.now && performance.now();
    }
    /**
     * Throttles a function and delays its execution, so it's only called at most
     * once within a given time period.
     * @param {Function} fn The function to throttle.
     * @param {number} timeout The amount of time that must pass before the
     *     function can be called again.
     * @return {Function} The throttled function.
     */
    function throttle(fn, timeout) {
        var timer = null;
        return function () {
            if (!timer) {
                timer = setTimeout(function() {
                    fn();
                    timer = null;
                }, timeout);
            }
        };
    }
    /**
     * Adds an event handler to a DOM node ensuring cross-browser compatibility.
     * @param {Node} node The DOM node to add the event handler to.
     * @param {string} event The event name.
     * @param {Function} fn The event handler to add.
     * @param {boolean} opt_useCapture Optionally adds the even to the capture
     *     phase. Note: this only works in modern browsers.
     */
    function addEvent(node, event, fn, opt_useCapture) {
        if (typeof node.addEventListener == 'function') {
            node.addEventListener(event, fn, opt_useCapture || false);
        }
        else if (typeof node.attachEvent == 'function') {
            node.attachEvent('on' + event, fn);
        }
    }
    /**
     * Removes a previously added event handler from a DOM node.
     * @param {Node} node The DOM node to remove the event handler from.
     * @param {string} event The event name.
     * @param {Function} fn The event handler to remove.
     * @param {boolean} opt_useCapture If the event handler was added with this
     *     flag set to true, it should be set to true here in order to remove it.
     */
    function removeEvent(node, event, fn, opt_useCapture) {
        if (typeof node.removeEventListener == 'function') {
            node.removeEventListener(event, fn, opt_useCapture || false);
        }
        else if (typeof node.detatchEvent == 'function') {
            node.detatchEvent('on' + event, fn);
        }
    }
    /**
     * Returns the intersection between two rect objects.
     * @param {Object} rect1 The first rect.
     * @param {Object} rect2 The second rect.
     * @return {?Object} The intersection rect or undefined if no intersection
     *     is found.
     */
    function computeRectIntersection(rect1, rect2) {
        var top = Math.max(rect1.top, rect2.top);
        var bottom = Math.min(rect1.bottom, rect2.bottom);
        var left = Math.max(rect1.left, rect2.left);
        var right = Math.min(rect1.right, rect2.right);
        var width = right - left;
        var height = bottom - top;
        return (width >= 0 && height >= 0) && {
            top: top,
            bottom: bottom,
            left: left,
            right: right,
            width: width,
            height: height
        };
    }
    /**
     * Shims the native getBoundingClientRect for compatibility with older IE.
     * @param {Element} el The element whose bounding rect to get.
     * @return {Object} The (possibly shimmed) rect of the element.
     */
    function getBoundingClientRect(el) {
        var rect;
        try {
            rect = el.getBoundingClientRect();
        } catch (err) {
            // Ignore Windows 7 IE11 "Unspecified error"
            // https://github.com/w3c/IntersectionObserver/pull/205
        }
        if (!rect) return getEmptyRect();
        // Older IE
        if (!(rect.width && rect.height)) {
            rect = {
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top
            };
        }
        return rect;
    }
    /**
     * Returns an empty rect object. An empty rect is returned when an element
     * is not in the DOM.
     * @return {Object} The empty rect.
     */
    function getEmptyRect() {
        return {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            width: 0,
            height: 0
        };
    }
    /**
     * Checks to see if a parent element contains a child element (including inside
     * shadow DOM).
     * @param {Node} parent The parent element.
     * @param {Node} child The child element.
     * @return {boolean} True if the parent node contains the child node.
     */
    function containsDeep(parent, child) {
        var node = child;
        while (node) {
            if (node == parent) return true;
            node = getParentNode(node);
        }
        return false;
    }
    /**
     * Gets the parent node of an element or its host element if the parent node
     * is a shadow root.
     * @param {Node} node The node whose parent to get.
     * @return {Node|null} The parent node or null if no parent exists.
     */
    function getParentNode(node) {
        var parent = node.parentNode;
        if (parent && parent.nodeType == 11 && parent.host) {
            // If the parent is a shadow root, return the host element.
            return parent.host;
        }
        if (parent && parent.assignedSlot) {
            // If the parent is distributed in a <slot>, return the parent of a slot.
            return parent.assignedSlot.parentNode;
        }
        return parent;
    }
// Exposes the constructors globally.
    window.IntersectionObserver = IntersectionObserver;
    window.IntersectionObserverEntry = IntersectionObserverEntry;
}());



// $r response.text() from fetch API to parser json
const $parser = $r => {
    let data = $r;
    try {
        data = JSON.parse(data);
    } catch {
        data = data.replace(/<b>|<\/b>|<br \/>/g, ' ');
    }
    return data;
};
const $getURL = function($url) {
    let url = '';
    if ($lang == 'mx') {
        url = decodeURI(window.location.pathname.replace('/mx', ''));
    } else {
        url = decodeURI(window.location.pathname);
    }
    let fu = url.split('/');
    for (let i = 0; i < fu.length; i++) {
        const e = fu[i];
        if (e == '') {
            fu.splice(i, 1);
        }
    }
    let r = fu[$url];
    return r;
};
Node.prototype.on = function(events, handler = null, callback = null, passive = false) {
    if (callback !== null && (handler != '' || handler != null)) {
        this.addEventListener(events, e => {
            e.stopPropagation();
            if (handler.includes('.') && e.target.classList.contains(handler.replace(/[.]/g, ''))) {
                callback(e.target, e);
            } else if (handler.includes('[') && e.target.hasAttribute(handler.replace(/[\[\]']+/g, ''))) {
                callback(e.target, e);
            } else {
                if (e.target.localName === handler) {
                    callback(e.target, e);
                }
            }
        }, passive);
    } else {
        console.error("The callback can't be null");
    }
};
Node.prototype.watch = function(event, fn, passive = false) {
    if (Array.isArray(event)) {
        event = event.split(' ');
        event.forEach((ev) => {
            this.addEventListener(ev, fn, passive);
        });
    } else {
        this.addEventListener(event, fn, passive);
    }
}
Node.prototype.unwatch = function(event, fn, passive = false) {
    if (Array.isArray(event)) {
        event = event.split(' ');
        event.forEach((ev) => {
            this.removeEventListener(ev, this, passive);
        });
    } else {
        this.removeEventListener(event, this, passive);
    }
}
NodeList.prototype.watch = function(event, fn, passive = false) {
    if (Array.isArray(event)) {;
        event.forEach($node => {
            this.forEach($ele => {
                $ele.addEventListener($node, fn, passive);
            });
        });
    } else {
        this.forEach($node => {
            $node.addEventListener(event, fn, passive);
        });
    }
}
NodeList.prototype.unwatch = function(event, passive = false) {
    if (Array.isArray(event)) {;
        event.forEach($node => {
            this.forEach($ele => {
                $ele.removeEventListener($node, this, passive);
            });
        });
    } else {
        this.forEach($node => {
            $node.removeEventListener(event, this, passive);
        });
    }
}
Node.prototype.prevSiblings = function() {
    let siblings = [];
    let n = this;
    if (n !== null && n !== undefined && n + '' !== '') {
        while (n = n.previousElementSibling) {
            siblings.push(n);
        }
        return siblings;
    } else {
        return siblings;
    }
}
// select all next elements siblings
/* @param element - type: DOM objet */
Node.prototype.nextSiblings = function() {
    let siblings = [];
    let n = this;
    if (n !== null && n !== undefined && n + '' !== '') {
        while (n = n.nextElementSibling) {
            siblings.push(n);
        }
        return siblings;
    } else {
        return siblings;
    }
}
// save all previous and next elements siblings in array objet
/* @param element - type: DOM objet */
Node.prototype.siblings = function() {
    let previus = this.prevSiblings() || [],
        next = this.nextSiblings() || [];
    return previus.concat(next);
};
Node.prototype.parent = function() {
    return this.parentElement;
};
Node.prototype.next = function() {
    return this.nextElementSibling;
};
Node.prototype.prev = function() {
    return this.previousElementSibling;
};
// clear element
Node.prototype.empty = function() {
    if (this) {
        this.innerHTML = '';
    } else {
        console.error('element is null');
    }
};
// add element in node
Node.prototype.append = function($string) {
    if (typeof($string) === 'string') {
        this.innerHTML += $string;
    } else {
        this.appendChild($string);
    }
};
Node.prototype.prepend = function($code) {
    this.insertAdjacentHTML("beforebegin", $code.minify());
};
// remove attr
Node.prototype.removeAttr = function($attr) {
    this.removeAttribute($attr);
};
// find similar object jquery
Node.prototype.find = function($elem) {
    return this.querySelector($elem);
};
// add class similar a jquery con soporte de arrays separadas por coma
Node.prototype.addClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.classList.add($class.trim());
        });
    } else {
        this.classList.add($classes);
    }
};
NodeList.prototype.addClass = function($classes) {
    this.forEach($el => {
        $el.classList.add($classes);
    });
};
// add to grouped class class similar a jquery con soporte de arrays separadas por coma
Node.prototype.groupAddClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.forEach($node => {
                $node.classList.add($class.trim());
            })
        });
    } else {
        this.forEach($node => {
            $node.classList.add($classes);
        })
    }
};
// comprueba class similar a jquery con soporte de arrays separadas por coma
Node.prototype.hasClass = function($classes) {
    return this.classList.contains($classes);
};
// remove class similar a jquery con soporte de arrays separadas por coma
Node.prototype.removeClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.classList.remove($class.trim());
        });
    } else {
        this.classList.remove($classes);
    }
};
NodeList.prototype.removeClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.forEach($el => {
                $el.classList.remove($class.trim());
            });
        });
    } else {
        this.forEach($el => {
            $el.classList.remove($classes.trim());
        });
    }
};

// remove to group class similar a jquery con soporte de arrays separadas por coma
Node.prototype.groupRemoveClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.forEach($node => {
                $node.classList.remove($class.trim());
            })
        });
    } else {
        this.forEach($node => {
            $node.classList.remove($classes);
        })
    }
};
// toggle class similar a jquery con soporte de arrays separadas por coma
Node.prototype.toggleClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.classList.toggle($class.trim());
        });
    } else {
        this.classList.toggle($classes);
    }
};
// toggle class similar a jquery con soporte de arrays separadas por coma
Node.prototype.replaceClass = function($classes, $replaces) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $replaces = $replaces.split(',');
        if ($classes.length == $replaces.length) {
            $classes.forEach(($index, $class) => {
                this.classList.replace($class.trim(), $replaces[$index]);
            });
        } else {
            console.error('the array of classes to replace is not the same length as the original array');
        }
    } else {
        this.classList.replace($classes, $replaces);
    }
};
NodeList.prototype.replaceClass = function($classes, $replaces) {
    this.forEach($el => {
        $el.classList.replace($classes, $replaces);
    });
};
// toggle class group class similar a jquery con soporte de arrays separadas por coma
Node.prototype.groupToggleClass = function($classes) {
    if ($classes.indexOf(',') !== -1) {
        $classes = $classes.split(',');
        $classes.forEach($class => {
            this.forEach($node => {
                $node.classList.toggle($class.trim());
            })
        });
    } else {
        this.forEach($node => {
            $node.classList.toggle($classes);
        })
    }
};
// set attribute
Node.prototype.attr = function($attr, $value = null) {
    if ($value != null) {
        this.setAttribute($attr, $value);
    } else {
        return this.getAttribute($attr);
    }
};

// insert after string code
Node.prototype.after = function($element) {
    this.insertAdjacentHTML('afterend', $element);
};

// insert before string code
Node.prototype.before = function($element) {
    this.insertAdjacentHTML('beforebegin', $element);
};
// css en linea las propiedades se declaran con _ y en codigo se reemplazan con -
Node.prototype.css = Node.prototype ? function($props) {
    let $style = [];
    $cache = [];
    for (let $prop in $props) {
        $cache.push($prop);
    }
    $cache.forEach((item) => {
        $style.push(`${item.replace('_','-')}: ${$props[item]}`);
    });
    this.attr('style', $style.join(';'));
} : null;
Node.prototype.text = function($text) {
    this.textContent = $text;
};
// invierte una cadna de texto
String.prototype.invert = function($string) {
    let x = $string.length;
    let $result = "";
    while (x >= 0) {
        $result = $result + $string.charAt(x);
        x--;
    }
    return $result;
};
// function clear string searching
// recieve parameter regex
String.prototype.scaped = function() {
    let $string = this;
    // Definimos los caracteres que queremos eliminar
    let $regex = arguments[0] ? arguments[0] : "!\"'|°!{}[]^<>@#$^&%*()+=[]\/{}|:<>?,.";
    // Los eliminamos todos
    for (let i = 0; i < $regex.length; i++) {
        $string = $string.replace(new RegExp("\\" + $regex[i], 'gi'), '');
    }
    // Quitamos acentos y "ñ". Fijate en que va sin comillas el primer parametro
    $string = $string.replace(/á/gi, "a");
    $string = $string.replace(/é/gi, "e");
    $string = $string.replace(/í/gi, "i");
    $string = $string.replace(/ó/gi, "o");
    $string = $string.replace(/ú/gi, "u");
    //reemplazamos dobles espacios por un espacio
    $string = $string.replace(/  /gi, " ");
    return $string;
};
String.prototype.minify = function() {
    return this.replace(/(?:\r\n|\r|\n|\t)/g, '');
};
String.prototype.toPrice = function() {
    let num = this;
    //console.log(num);
    if (!num || num == 'NaN') return '-';
    if (num == 'Infinity') return '&#x221e;';
    num = num.toString().replace(/\$|\,/g, '');
    if (isNaN(num))
        num = "0";
    let sign = (num == (num = Math.abs(num)));
    num = Math.floor(num * 100 + 0.50000000001);
    let cents = num % 100;
    num = Math.floor(num / 100).toString();
    if (cents < 10)
        cents = "0" + cents;
    for (var i = 0; i < Math.floor((num.length - (1 + i)) / 3); i++)
        num = num.substring(0, num.length - (4 * i + 3)) + ',' + num.substring(num.length - (4 * i + 3));
    //console.log(cents);
    return (((sign) ? '' : '-') + num + '.' + cents);
};
Number.prototype.toPrice = function() {
    let num = this;
    //console.log(num);
    if (!num || num == 'NaN') return '-';
    if (num == 'Infinity') return '&#x221e;';
    num = num.toString().replace(/\$|\,/g, '');
    if (isNaN(num))
        num = "0";
    let sign = (num == (num = Math.abs(num)));
    num = Math.floor(num * 100 + 0.50000000001);
    let cents = num % 100;
    num = Math.floor(num / 100).toString();
    if (cents < 10)
        cents = "0" + cents;
    for (var i = 0; i < Math.floor((num.length - (1 + i)) / 3); i++)
        num = num.substring(0, num.length - (4 * i + 3)) + ',' + num.substring(num.length - (4 * i + 3));
    //console.log(cents);
    return (((sign) ? '' : '-') + num + '.' + cents);
};
Array.prototype.unique = function(a) {
    return function() { return this.filter(a) }
}
(function(a, b, c) {
    return c.indexOf(a, b + 1) < 0
});
if (!('firstUpperCase' in String.prototype)) {
    String.prototype.firstUpperCase = function() {
        return this.charAt(0).toUpperCase() + this.slice(1).toLowerCase();
    };
}

var fNumber = {
    sepMil: ".", // separador para los miles
    sepDec: ',', // separador para los decimales
    formatear: function(num) {
        num += '';
        var splitStr = num.split('.');
        var splitLeft = splitStr[0];
        var splitRight = splitStr.length > 1 ? this.sepDec + splitStr[1] : '';
        var regx = /(\d+)(\d{3})/;
        while (regx.test(splitLeft)) {
            splitLeft = splitLeft.replace(regx, '$1' + this.sepMil + '$2');
        }
        return this.simbol + splitLeft + splitRight;
    },
    go: function(num, simbol) {
        this.simbol = simbol || '';
        return this.formatear(num);
    }
}
// functions
//
////////
// iPhone model checks
// Reference: https://www.paintcodeapp.com/news/ultimate-guide-to-iphone-resolutions
function getiPhoneModel() {
    // Create a canvas element which can be used to retrieve information about the GPU.
    var canvas = document.createElement("canvas");
    if (canvas) {
        var context = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (context) {
            var info = context.getExtension("WEBGL_debug_renderer_info");
            if (info) {
                var renderer = context.getParameter(info.UNMASKED_RENDERER_WEBGL);
            }
        }
    }
    // iPhone Xr
    if ((window.screen.height / window.screen.width == 896 / 414) && (window.devicePixelRatio == 2)) {
        return "iPhone Xr";
    }
    // iPhone Xs Max
    else if ((window.screen.height / window.screen.width == 896 / 414) && (window.devicePixelRatio == 3)) {
        return "iPhone Xs Max";
    }
    // iPhone X / iPhone XS
    else if ((window.screen.height / window.screen.width == 812 / 375) && (window.devicePixelRatio == 3)) {
        switch (renderer) {
            default: return "iPhone X or Xs";
            case "Apple A11 GPU":
                return "iPhone X";
            case "Apple A12 GPU":
                return "iPhone Xs";
        }
        // iPhone 6+/6s+/7+ and 8+
    } else if ((window.screen.height / window.screen.width == 736 / 414) && (window.devicePixelRatio == 3)) {
        switch (renderer) {
            default: return "iPhone 6 Plus, 6s Plus, 7 Plus or 8 Plus";
            case "Apple A8 GPU":
                return "iPhone 6 Plus";
            case "Apple A9 GPU":
                return "iPhone 6s Plus";
            case "Apple A10 GPU":
                return "iPhone 7 Plus";
            case "Apple A11 GPU":
                return "iPhone 8 Plus";
        }
        // iPhone 6+/6s+/7+ and 8+ in zoom mode
    } else if ((window.screen.height / window.screen.width == 667 / 375) && (window.devicePixelRatio == 3)) {
        switch (renderer) {
            default: return "iPhone 6 Plus, 6s Plus, 7 Plus or 8 Plus (display zoom)";
            case "Apple A8 GPU":
                return "iPhone 6 Plus (display zoom)";
            case "Apple A9 GPU":
                return "iPhone 6s Plus (display zoom)";
            case "Apple A10 GPU":
                return "iPhone 7 Plus (display zoom)";
            case "Apple A11 GPU":
                return "iPhone 8 Plus (display zoom)";
        }
        // iPhone 6/6s/7 and 8
    } else if ((window.screen.height / window.screen.width == 667 / 375) && (window.devicePixelRatio == 2)) {
        switch (renderer) {
            default: return "iPhone 6, 6s, 7 or 8";
            case "Apple A8 GPU":
                return "iPhone 6";
            case "Apple A9 GPU":
                return "iPhone 6s";
            case "Apple A10 GPU":
                return "iPhone 7";
            case "Apple A11 GPU":
                return "iPhone 8";
        }
        // iPhone 5/5C/5s/SE or 6/6s/7 and 8 in zoom mode
    } else if ((window.screen.height / window.screen.width == 1.775) && (window.devicePixelRatio == 2)) {
        switch (renderer) {
            default: return "iPhone 5, 5C, 5S, SE or 6, 6s, 7 and 8 (display zoom)";
            case "PowerVR SGX 543":
                return "iPhone 5 or 5c";
            case "Apple A7 GPU":
                return "iPhone 5s";
            case "Apple A8 GPU":
                return "iPhone 6 (display zoom)";
            case "Apple A9 GPU":
                return "iPhone SE or 6s (display zoom)";
            case "Apple A10 GPU":
                return "iPhone 7 (display zoom)";
            case "Apple A11 GPU":
                return "iPhone 8 (display zoom)";
        }
        // iPhone 4/4s
    } else if ((window.screen.height / window.screen.width == 1.5) && (window.devicePixelRatio == 2)) {
        switch (renderer) {
            default: return "iPhone 4 or 4s";
            case "PowerVR SGX 535":
                return "iPhone 4";
            case "PowerVR SGX 543":
                return "iPhone 4s";
        }
        // iPhone 1/3G/3GS
    } else if ((window.screen.height / window.screen.width == 1.5) && (window.devicePixelRatio == 1)) {
        switch (renderer) {
            default: return "iPhone 1, 3G or 3GS";
            case "ALP0298C05":
                return "iPhone 3GS";
            case "S5L8900":
                return "iPhone 1, 3G";
        }
    } else {
        return "Other phone";
    }
}
const $fetch = async function(data = null, $url = REQUEST_API) {
    let $response = data;
    let $globals = [];
    const $data = new FormData();
    if ($response !== null) {
        for (let $var in $response) {
            $globals.push($var);
        }
        $globals.forEach($var => {
            $data.append($var, data[$var]);
        });
        $response = await fetch($url, {
            method: 'POST',
            body: $data
        });
        $response = await $response.text();
        $response = await $parser($response);
        return $response;
    } else {
        console.error($errors.ajax[$lang]);
    }
};
// get mthod ajax
const $get = async function({ url = null, method = 'GET' }) {
    let $response = null;
    let $request = url;
    let $method = method;
    if ($request !== null) {
        $response = await fetch($request, {
            method: $method
        });
        $response = await $response.text();
        $response = await $parser($response);
        return $response;
    } else {
        console.error($errors.ajax[$lang]);
    }
};
const $root = `${window.location.hostname}`;
const $validMail = /^(([^<>()\[\]\.,;:\s@\"]+(\.[^<>()\[\]\.,;:\s@\"]+)*)|(\".+\"))@(([^<>()[\]\.,;:\s@\"]+\.)+[^<>()[\]\.,;:\s@\"]{2,})$/i;