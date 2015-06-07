require(["ramda", "webgl_helpers", "functional_utils"], function(r, w, fun) {
    "use strict";

    //constants
    var minSegLen = 0.025;
    var maxSegLen = 0.15;
    var minGroundHeight = 0.1;
    var maxGroundHeight = 0.45;
    var flatChance = 0.6;
    var gravity = [0, -0.2];
    var ballRadius = 0.01;
    var ballSectors = 16;
    var bounceLoss = 0.3;
    var canvas = document.getElementById("canvas");
    var xpx = canvas.clientWidth;
    var ypx = canvas.clientHeight;
    var shotStrength = 1.5;
    var holeFlatWidth = 0.01;
    var halfHoleWidth = 0.02;
    var holeWidth = holeFlatWidth + halfHoleWidth;
    var holeDepth = 0.05;
    var holePattern = [
        [-holeFlatWidth - halfHoleWidth, 0], [-halfHoleWidth, 0],
        [-halfHoleWidth, -holeDepth], [halfHoleWidth, -holeDepth],
        [halfHoleWidth, 0], [holeFlatWidth + halfHoleWidth, 0]];
    var gameSpeed = 0.0022;

    //state
    var program;
    var gl;
    var ballPosition;
    var startingPosition;
    var ballVelocity = [0, 0];
    var lastTimestamp;
    var currentLandscape;
    var ballStill = true;
    var shooting = false;
    var aimStartPos;
    var aimEndPos;
    var bottomOfHole;
    var shots = 0;
    var completed = 0;

    var translationMat = function (translation) {
        return [[1, 0, translation[0]],
               [0, 1, translation[1]],
               [0, 0, 1]];
    };

    var rotationMat = function (angle) {
        var c = Math.cos(angle);
        var s = Math.sin(angle);
        return [[c, -s, 0],
               [s, c, 0],
               [0, 0, 1]];
    };

    var scaleMat = function (scale) {
        if (typeof scale === "number") {
            scale = [scale, scale];
        }
        return [[scale[0], 0, 0],
               [0, scale[1], 0],
               [0, 0, 1]];
    };

    var transpose = function(matrix) {
        return fun.apply(fun.map, fun.array, matrix);
    };

    var matrixMul = function () {
        var mul2 = function(a, b) {
            b = transpose(b);
            var result = [];
            for (var i = 0; i < a.length; i++) {
                var row = a[i];
                for (var j = 0; j < b.length; j++) {
                    var col = b[j];
                    result.push(dot(row, col));
                }
            }
            return fun.partition(3, result);
        };
        return fun.reduce(mul2, arguments);
    };

    var rotateVec = function(v, angle) {
        var x = v[0];
        var y = v[1];
        return [x * Math.cos(angle) - y * Math.sin(angle),
               x * Math.sin(angle) + y * Math.cos(angle)];
    };

    var add = function() {
        return r.reduce(function (x, y) {return x + y;}, 0, arguments);
    };

    var sub = function() {
        var sub2 = function (x, y) {return x - y;};
        if (arguments.length < 2) {
            return r.reduce(sub2, 0, arguments);
        }
        return fun.reduce(sub2, arguments);
    };

    var mul = function() {
        return r.reduce(function (x, y) {return x * y;}, 1, arguments);
    };

    var scaleVec = function(s, v) {
        return r.map(r.multiply(s), v);
    };

    var vecAdd = function(u, v) {
        return fun.map(add, u, v);
    };

    var vecSub = function(u, v) {
        return fun.map(sub, u, v);
    };

    var magnitude = function(v) {
        return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
    };

    var normalize = function(v) {
        return scaleVec(1 / magnitude(v), v);
    };

    var dot = function(u, v) {
        return r.apply(add, fun.map(mul, u, v));
    };

    var angleBetween = function(u, v) {
        return Math.acos(dot(normalize(u), normalize(v)));
    };

    var signedAngleBetween = function(u, v) {
        u = normalize(u);
        v = normalize(v);
        return Math.asin(u[0] * v[1] - u[1] * v[0]);
    };

    var linesIntersect = function(l1, l2) {
        var points = [l1[0], l2[0], l1[1], l2[1]];
        for (var i = 0; i < 4; i ++) {
            var p = points[i];
            var v1 = vecSub(points[(i + 1) % 4], p);
            var vo = vecSub(points[(i + 2) % 4], p);
            var v2 = vecSub(points[(i + 3) % 4], p);
            var angle12 = angleBetween(v1, v2);
            var angleo1 = angleBetween(vo, v1);
            var angleo2 = angleBetween(vo, v2);
            if (angle12 < angleo1 || angle12 < angleo2) {
                return false;
            }
        }
        return true;
    };

    var rand = function(min, max) {
        if (max === undefined) {
            max = min;
            min = 0;
        }
        return min + Math.random() * (max - min);
    };

    var randInt = function(min, max) {
        return Math.floor(rand(min, max));
    };

    var chance = function(chance) {
        return rand(1) < chance ? true : false;
    };

    var randomPoint = function() {
        return [rand(minSegLen, maxSegLen),
               rand(minGroundHeight, maxGroundHeight)];
    };

    //flatChance === 1 means every second segment becomes flat
    var insertFlatSegments = function(flatChance, points) {
        return fun.mapcat(
                function (p) {
                    return chance(flatChance) ? [p, [rand(minSegLen, maxSegLen), p[1]]] : [p];
                },
                points);
    };

    var epilocation = function(pos, ground) {
        var x = pos[0];
        var line = function findLine(i) {
            if (ground[i][0] > x) {
                return [ground[i - 1], ground[i]];
            }
            return findLine(i + 1);
        }(0);
        var p = line[0];
        var q = line[1];
        var y = p[1] + (x - p[0]) / (q[0] - p[0]) * (q[1] - p[1]);
        return [x, y];
    };

    var distanceToGround = function(pos, ground) {
        return magnitude(vecSub(pos, epilocation(pos, ground)));
    };

    var landscape = function() {
        var points = insertFlatSegments(flatChance,
                fun.cons([0, 0.4],
                    fun.repeatedly(1 / minSegLen + 1, randomPoint)));
        var lastPoint = points[0];
        return r.map(
                function(p) {
                    var newX = p[0] + lastPoint[0];
                    var newP = r.update(0, newX, p);
                    lastPoint = newP;
                    return newP;
                },
                points);
    };

    var toGlslFormat = function(matrix) {
        return r.flatten(transpose(matrix));
    };

    var drawGraphics = function(vertices, mode, color, transformation) {
        transformation = transformation || {};
        var translation = transformation.translation || [0, 0];
        var rotation = transformation.rotation || 0;
        var scale = transformation.scale || 1;
        var matrix = matrixMul(
                translationMat(translation),
                rotationMat(rotation),
                scaleMat(scale));
        var matrixLoc = gl.getUniformLocation(program, "u_matrix");
        gl.uniformMatrix3fv(matrixLoc, gl.FALSE, toGlslFormat(matrix));
        var colorLoc = gl.getUniformLocation(program, "u_color");
        gl.uniform3fv(colorLoc, color);
        var positionLoc = gl.getAttribLocation(program, "a_position");
        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices),
                gl.STATIC_DRAW);
        gl.enableVertexAttribArray(positionLoc);
        gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(mode, 0, r.length(vertices) / 2);
    };

    var pointOnCircle = function(angle) {
        return [Math.cos(angle), Math.sin(angle)];
    };

    var drawBall = function() {
        var ballPoints = r.map(pointOnCircle,
                r.map(function (factor) {return 2 * Math.PI / ballSectors * factor;},
                    r.range(0, ballSectors)));

        ballPoints = r.map(function(p) {return r.map(r.multiply(ballRadius), p);},
                ballPoints);

        drawGraphics(r.flatten(ballPoints), gl.TRIANGLE_FAN, [1, 1, 1], {
            translation: ballPosition});
    };

    var pointsForDrawing = function(pair) {
        var p = pair[0];
        var q = pair[1]
            var bp = [p[0], 0];
        var bq = [q[0], 0];
        return [p, q, bp,
               bq, bp, q];
    };

    var drawGround = function() {
        var pairs = fun.partition(2, 1, currentLandscape);
        var vertices = r.flatten(r.map(pointsForDrawing, pairs));
        drawGraphics(vertices, gl.TRIANGLES, [0, 0.9, 0]);
    };

    var drawAimLine = function() {
        var aimEndPosVector = vecSub(aimEndPos, aimStartPos);
        var line = [ballPosition, vecAdd(ballPosition, aimEndPosVector)];
        drawGraphics(r.flatten(line), gl.LINES, [1, 1, 0]);
    };

    var drawFlag = function() {
        var w = 0.004;
        var h = 0.09;
        var fh = 0.03;
        var fl = 0.04;
        var pole = [[-w, h], [w, h], [-w, 0],
            [w, h], [-w, 0], [w, 0]];
        var flag = [[w, h], [w + fl, h - fh / 2], [w, h - fh]];
        var transformation = {translation: bottomOfHole};
        drawGraphics(r.flatten(pole), gl.TRIANGLES, [0.8, 0.4, 0.2],
                transformation);
        drawGraphics(r.flatten(flag), gl.TRIANGLES, [1, 0, 0],
                transformation);
    };


    var drawScene = function() {
        gl.clearColor(0.5, 0.5, 1.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        drawGround();
        drawFlag();
        if (shooting) {
            drawAimLine();
        };
        drawBall();
    };

    var updateScore = function() {
        document.getElementById("hole").innerHTML = (completed + 1);
        document.getElementById("shots").innerHTML = shots;
        document.getElementById("per-hole").innerHTML = shots / (completed + 1);
    };

    var setupGame = function() {
        var land = landscape();
        var pointsNeeded = r.length(r.takeWhile(function (p) {return p[0] < 1;},
                    land)) + 1;
        land = r.take(pointsNeeded, land);

        startingPosition = ballPosition = fun.updateNumber(1, 0.001,
                epilocation([0.1, 1], land));

        var holePos = epilocation([rand(0.7, 0.9), 1], land);
        bottomOfHole = fun.updateNumber(1, -holeDepth, holePos);
        var before = [];
        var after = land;
        var hole = r.map(r.partial(vecAdd, holePos), holePattern);
        currentLandscape = function insertHole(holeX) {
            if (after[0][0] > holeX) {
                before = function fixBefore(before) {
                    if (fun.last(before)[0] + holeWidth > holeX) {
                        return fixBefore(fun.butlast(before));
                    }
                    return before;
                }(before);

                after = function fixAfter(after) {

                    if (fun.first(after)[0] - holeWidth < holeX) {
                        return fixAfter(fun.rest(after));
                    }
                    return after;
                }(after);

                return fun.concat(before, hole, after);

            } else {
                before.push(after[0]);
                after = fun.rest(after);
            }
            return insertHole(holeX);
        }(holePos[0]);
    };

    var mouseLocation = function(e) {
        return [e.layerX / xpx, 1 - e.layerY / ypx]
    };

    var beginShooting = function(e) {
        if (ballStill) {
            shooting = true;
            aimStartPos = mouseLocation(e);
        };
    };

    var shoot = function(e) {
        if (shooting) {
            shooting = false;
            ballStill = false;
            var loc = mouseLocation(e);
            ballVelocity = scaleVec(shotStrength, vecSub(loc, aimStartPos));
            shots += 1;
            updateScore();
        };
    };

    var aim = function(e) {
        aimEndPos = mouseLocation(e);
    };

    var inHole = function(ball, hole) {
        return magnitude(vecSub(ball, hole)) <= halfHoleWidth;
    };

    var logic = function(delta) {
        if (!ballStill) {
            bounce(delta);
        }
        if (ballStill && inHole(ballPosition, bottomOfHole)) {
            completed += 1;
            setupGame();
            updateScore();
        }
    };

    var outOfBounds = function(pos) {
        var x = pos[0];
        return x <= 0 || x >= 1;
    };

    var bounce = function(delta) {
        delta *= gameSpeed;

        if (outOfBounds(ballPosition)) {
            ballPosition = startingPosition;
            ballVelocity = [0, 0];
            ballStill = true;
            return;
        };

        var findIntersectingSegment = function(line) {
            return fun.first(r.filter(r.partial(linesIntersect, line),
                        fun.partition(2, 1, currentLandscape)));
        };

        var addDeltaVector = function(addition, to) {
            return vecAdd(scaleVec(delta, addition), to);
        };

        ballVelocity = addDeltaVector(gravity, ballVelocity);

        var calculateVelocity = function(velocity) {
            var toGround = distanceToGround(ballPosition, currentLandscape);
            if (magnitude(velocity) < 0.01 && toGround < 0.001) {
                ballStill = true;
                return [0, 0];
            }

            var newPosition = addDeltaVector(velocity, ballPosition);

            var line = findIntersectingSegment([ballPosition, newPosition]);
            if (line) {
                var surface = vecSub(line[1], line[0]);
                var normal = rotateVec(surface, Math.PI / 2);
                var reflectedVelocity = scaleVec(-1, velocity);
                var angle = signedAngleBetween(reflectedVelocity, normal);

                velocity = scaleVec(1 - bounceLoss,
                        rotateVec(reflectedVelocity, 2 * angle));
                return calculateVelocity(velocity);
            }
            return velocity;
        };

        ballVelocity = calculateVelocity(ballVelocity);
        ballPosition = addDeltaVector(ballVelocity, ballPosition);
    };

    var mainLoop = function(now) {
        var delta = now - lastTimestamp;
        lastTimestamp = now;

        logic(delta);
        drawScene();
        window.requestAnimationFrame(mainLoop);
    };

    var main = function() {
        var canvas = document.getElementById("canvas");
        canvas.onmousemove = aim;
        canvas.onmousedown = beginShooting;
        canvas.onmouseup = shoot;

        gl = canvas.getContext("webgl");
        program = w.programFromScripts(gl, "vshader", "fshader");
        gl.useProgram(program);

        lastTimestamp = performance.now();
        setupGame();

        window.requestAnimationFrame(mainLoop);
    };

    main();
});