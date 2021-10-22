/*
 * Copyright (C) 2015-2021 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS''
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */
Sampler = Utilities.createClass(
    function(seriesCount, expectedSampleCount, processor)
    {
        this._processor = processor;

        this.samples = [];
        for (var i = 0; i < seriesCount; ++i) {
            var array = new Array(expectedSampleCount);
            array.fill(0);
            this.samples[i] = array;
        }
        this.sampleCount = 0;
    }, {

    record: function() {
        // Assume that arguments.length == this.samples.length
        for (var i = 0; i < arguments.length; i++) {
            this.samples[i][this.sampleCount] = arguments[i];
        }
        ++this.sampleCount;
    },

    processSamples: function()
    {
        var results = {};

        // Remove unused capacity
        this.samples = this.samples.map(function(array) {
            return array.slice(0, this.sampleCount);
        }, this);

        this._processor.processSamples(results);

        return results;
    }
});

Controller = Utilities.createClass(
    function(benchmark, options)
    {
        // Initialize timestamps relative to the start of the benchmark
        // In start() the timestamps are offset by the start timestamp
        this._startTimestamp = 0;
        this._endTimestamp = options["test-interval"];
        console.log("options[test-interval] = " + options["test-interval"] + ", this._endTimestamp = " + this._endTimestamp);
        // Default data series: timestamp, complexity, estimatedFrameLength
        var sampleSize = options["sample-capacity"] || (60 * options["test-interval"] / 1000);
        console.log("sampleSize = " + sampleSize);

        this._sampler = new Sampler(options["series-count"] || 3, sampleSize, this);
        this._marks = {};

        this._frameLengthEstimator = new SimpleKalmanEstimator(options["kalman-process-error"], options["kalman-measurement-error"]);
        this._isFrameLengthEstimatorEnabled = true;

        // Length of subsequent intervals; a value of 0 means use no intervals
        this.intervalSamplingLength = 100;

        this.initialComplexity = 1;
    }, {

    set isFrameLengthEstimatorEnabled(enabled) {
        this._isFrameLengthEstimatorEnabled = enabled;
    },

    start: function(startTimestamp, stage)
    {
        this._startTimestamp = startTimestamp;
        console.log("Controller.start(), startTimestamp = " + startTimestamp + ", this._endTimestamp = " + this._endTimestamp);
        this._endTimestamp += startTimestamp;//修正benchmark结束的时间，30000+warmup的时间
        console.log("Controller.start(), startTimestamp = " + startTimestamp + ", this._endTimestamp = " + this._endTimestamp);
        this._previousTimestamp = startTimestamp;//这里startTimestamp即为当前的timestamp
        this._measureAndResetInterval(startTimestamp);//主要的目的是计算averageFrameLength, this._intervalEndTimestamp = 30000+warmup+100
        console.log("Controller.start(), this._intervalEndTimestamp = " + this._intervalEndTimestamp);
        this.recordFirstSample(startTimestamp, stage);
    },

    recordFirstSample: function(startTimestamp, stage)
    {
        this._sampler.record(startTimestamp, stage.complexity(), -1);
        this.mark(Strings.json.samplingStartTimeOffset, startTimestamp);
    },

    mark: function(comment, timestamp, data) {
        data = data || {};
        data.time = timestamp;
        data.index = this._sampler.sampleCount;
        this._marks[comment] = data;
    },

    containsMark: function(comment) {
        return comment in this._marks;
    },

    filterOutOutliers: function(array)
    {
        if (array.length == 0)
            return [];

        array.sort((a, b) => a - b);
        var q1 = array[Math.min(Math.round(array.length * 1 / 4), array.length - 1)];
        var q3 = array[Math.min(Math.round(array.length * 3 / 4), array.length - 1)];
        var interquartileRange = q3 - q1;
        var minimum = q1 - interquartileRange * 1.5;
        var maximum = q3 + interquartileRange * 1.5;
        return array.filter(x => x >= minimum && x <= maximum);
    },

    _measureAndResetInterval: function(currentTimestamp)
    {
        var sampleCount = this._sampler.sampleCount;
        //console.log("sampleCount = %d, this._sampler.length = %d, this._intervalEndTimestamp = %d", sampleCount, this._sampler.length, this._intervalEndTimestamp);
        var averageFrameLength = 0;

        //如果_intervalEndTimestamp非空,最终的目的是计算averageFrameLength
        if (this._intervalEndTimestamp) {
            var durations = [];
            for (var i = Math.max(this._intervalStartIndex, 1); i < sampleCount; ++i) {
                durations.push(this._sampler.samples[0][i] - this._sampler.samples[0][i - 1]);
            }
            var filteredDurations = this.filterOutOutliers(durations);
            if (filteredDurations.length > 0)
                averageFrameLength = filteredDurations.reduce((a, b) => a + b, 0) / filteredDurations.length;
        }

        this._intervalStartIndex = sampleCount;//_intervalStartIndex从0开始
        this._intervalEndTimestamp = currentTimestamp + this.intervalSamplingLength;//intervalSamplingLength = 100,得到每一个interval结束的时间
        console.log("   _measureAndResetInterval(), this._intervalStartIndex = "+this._intervalStartIndex+", this._intervalEndTimestamp = "+this._intervalEndTimestamp);
        return averageFrameLength;
    },

    update: function(timestamp, stage) //timestamp为当前时刻
    {
        var lastFrameLength = timestamp - this._previousTimestamp; //lastFrameLength: 当前帧与上一帧之间的时间间隔
        //console.log("   in update(), lastFrameLength = %d, intervalSamplingLength = %d", lastFrameLength, this.intervalSamplingLength);
        this._previousTimestamp = timestamp;

        var frameLengthEstimate = -1, intervalAverageFrameLength = -1;
        var didFinishInterval = false;
        if (!this.intervalSamplingLength) {
            //intervalSamplingLength=100,没有观察到会进这个branch
            console.log("++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
            if (this._isFrameLengthEstimatorEnabled) {
                this._frameLengthEstimator.sample(lastFrameLength);
                frameLengthEstimate = this._frameLengthEstimator.estimate;
            }
        } else {
            this.registerFrameTime(lastFrameLength);//save当前帧时间
            console.log(" line 173: in update(), timestamp = "+timestamp+"， this._intervalEndTimestamp = "+this._intervalEndTimestamp);
            if (this.intervalHasConcluded(timestamp)) { //时间上达到_intervalEndTimestamp，30000+warmup+1000，且this.filterOutOutliers(this._frameTimeHistory)中有超过10个frames
                console.log(" line 175: timestamp = "+timestamp+"， this._intervalEndTimestamp = "+this._intervalEndTimestamp);
                var intervalStartTimestamp = this._sampler.samples[0][this._intervalStartIndex];
                intervalAverageFrameLength = this._measureAndResetInterval(timestamp);
                if (this._isFrameLengthEstimatorEnabled) {
                    this._frameLengthEstimator.sample(intervalAverageFrameLength);
                    frameLengthEstimate = this._frameLengthEstimator.estimate;
                }
                //采样100ms内的平均frameLength
                didFinishInterval = true;
                //console.log("   in update(): intervalHasConcluded()==true, didFinishInterval(), timestamp = %d, stage = %s, intervalAverageFrameLength = %d", timestamp, stage, intervalAverageFrameLength);
                this.didFinishInterval(timestamp, stage, intervalAverageFrameLength);
                this._frameLengthEstimator.reset();
            }
        }

        this._sampler.record(timestamp, stage.complexity(), frameLengthEstimate);
        //调整场景的复杂程度?
        console.log("   this.tune()");
        this.tune(timestamp, stage, lastFrameLength, didFinishInterval, intervalAverageFrameLength);
    },

    registerFrameTime: function(lastFrameLength)
    {
    },

    intervalHasConcluded: function(timestamp)
    {
        console.log("  in intervalHasConcluded(), timestamp = "+timestamp+"， this._intervalEndTimestamp = "+this._intervalEndTimestamp);
        var f = timestamp >= this._intervalEndTimestamp;
        console.log("  in intervalHasConcluded(), timestamp >= this._intervalEndTimestamp = "+f);

        //判断当前时刻timestamp是否超过intervalEndTimestamp, 其中_intervalEndTimestamp = currentTimestamp + intervalSamplingLength(也就是100)
        return timestamp >= this._intervalEndTimestamp;
    },

    didFinishInterval: function(timestamp, stage, intervalAverageFrameLength)
    {
    },

    tune: function(timestamp, stage, lastFrameLength, didFinishInterval, intervalAverageFrameLength)
    {
    },

    shouldStop: function(timestamp)
    {
        //console.log("in shouldStop(), timestamp = %d, this._endTimestamp = %d", timestamp, this._endTimestamp);
        return timestamp > this._endTimestamp; //
    },

    results: function()
    {
        return this._sampler.processSamples();
    },

    _processComplexitySamples: function(complexitySamples)
    {
        complexitySamples.sort(function(a, b) {
            return complexitySamples.getFieldInDatum(a, Strings.json.complexity) - complexitySamples.getFieldInDatum(b, Strings.json.complexity);
        });
    },

    _processMarks: function()
    {
        for (var markName in this._marks)
            this._marks[markName].time -= this._startTimestamp;
        return this._marks;
    },
    _processControllerSamples: function()
    {
        var controllerSamples = new SampleData;
        controllerSamples.addField(Strings.json.time, 0);
        controllerSamples.addField(Strings.json.complexity, 1);
        controllerSamples.addField(Strings.json.frameLength, 2);
        controllerSamples.addField(Strings.json.smoothedFrameLength, 3);

        var samples = this._sampler.samples;
        samples[0].forEach(function(timestamp, i) {
            var sample = controllerSamples.createDatum();
            controllerSamples.push(sample);

            // Represent time in milliseconds
            controllerSamples.setFieldInDatum(sample, Strings.json.time, timestamp - this._startTimestamp);
            controllerSamples.setFieldInDatum(sample, Strings.json.complexity, samples[1][i]);

            if (i == 0)
                controllerSamples.setFieldInDatum(sample, Strings.json.frameLength, 1000/60);
            else
                controllerSamples.setFieldInDatum(sample, Strings.json.frameLength, timestamp - samples[0][i - 1]);

            if (samples[2][i] != -1)
                controllerSamples.setFieldInDatum(sample, Strings.json.smoothedFrameLength, samples[2][i]);
        }, this);

        return controllerSamples;
    },

    processSamples: function(results)
    {
        results[Strings.json.marks] = this._processMarks();

        var controllerSamples = this._processControllerSamples();
        var complexitySamples = new SampleData(controllerSamples.fieldMap);

        results[Strings.json.samples] = {};
        results[Strings.json.samples][Strings.json.controller] = controllerSamples;
        results[Strings.json.samples][Strings.json.complexity] = complexitySamples;
        controllerSamples.forEach(function (sample) {
            complexitySamples.push(sample);
        });
        this._processComplexitySamples(complexitySamples);
    }
});

FixedController = Utilities.createSubclass(Controller,
    function(benchmark, options)
    {
        Controller.call(this, benchmark, options);
        this.initialComplexity = options["complexity"];
        this.intervalSamplingLength = 0;
    }
);

AdaptiveController = Utilities.createSubclass(Controller,
    function(benchmark, options)
    {
        // Data series: timestamp, complexity, estimatedIntervalFrameLength
        Controller.call(this, benchmark, options);

        // All tests start at 0, so we expect to see 60 fps quickly.
        this._samplingTimestamp = options["test-interval"] / 2;
        this._startedSampling = false;
        this._targetFrameRate = options["frame-rate"];
        this._pid = new PIDController(this._targetFrameRate);

        this._intervalFrameCount = 0;
        this._numberOfFramesToMeasurePerInterval = 4;
    }, {

    start: function(startTimestamp, stage)
    {
        Controller.prototype.start.call(this, startTimestamp, stage);

        this._samplingTimestamp += startTimestamp;
        this._intervalTimestamp = startTimestamp;
    },

    recordFirstSample: function(startTimestamp, stage)
    {
        this._sampler.record(startTimestamp, stage.complexity(), -1);
    },

    update: function(timestamp, stage)
    {
        if (!this._startedSampling && timestamp >= this._samplingTimestamp) {
            this._startedSampling = true;
            this.mark(Strings.json.samplingStartTimeOffset, this._samplingTimestamp);
        }

        // Start the work for the next frame.
        ++this._intervalFrameCount;

        if (this._intervalFrameCount < this._numberOfFramesToMeasurePerInterval) {
            this._sampler.record(timestamp, stage.complexity(), -1);
            return;
        }

        // Adjust the test to reach the desired FPS.
        var intervalLength = timestamp - this._intervalTimestamp;
        this._frameLengthEstimator.sample(intervalLength / this._numberOfFramesToMeasurePerInterval);
        var intervalEstimatedFrameRate = 1000 / this._frameLengthEstimator.estimate;
        var tuneValue = -this._pid.tune(timestamp - this._startTimestamp, intervalLength, intervalEstimatedFrameRate);
        tuneValue = tuneValue > 0 ? Math.floor(tuneValue) : Math.ceil(tuneValue);
        stage.tune(tuneValue);

        this._sampler.record(timestamp, stage.complexity(), this._frameLengthEstimator.estimate);

        // Start the next interval.
        this._intervalFrameCount = 0;
        this._intervalTimestamp = timestamp;
    }
});

RampController = Utilities.createSubclass(Controller,
    function(benchmark, options)
    {
        // The tier warmup takes at most 5 seconds
        options["sample-capacity"] = (options["test-interval"] / 1000 + 5) * 60;
        Controller.call(this, benchmark, options);

        // Initially start with a tier test to find the bounds
        // The number of objects in a tier test is 10^|_tier|
        this._tier = -.5;
        // The timestamp is first set after the first interval completes
        this._tierStartTimestamp = 0;
        this._minimumComplexity = 1;
        this._maximumComplexity = 1;

        this._testLength = options["test-interval"];

        // After the tier range is determined, figure out the number of ramp iterations
        var minimumRampLength = 3000;
        var totalRampIterations = Math.max(1, Math.floor(this._endTimestamp / minimumRampLength));
        // Give a little extra room to run since the ramps won't be exactly this length
        this._rampLength = Math.floor((this._endTimestamp - totalRampIterations * this.intervalSamplingLength) / totalRampIterations);
        //console.log("this._endTimestamp = %d, totalRampIterations = %d, intervalSamplingLength = %d, _rampLength = %d", this._endTimestamp, totalRampIterations, this.intervalSamplingLength, this._rampLength);
        this._rampDidWarmup = false;
        this._rampRegressions = [];

        this._finishedTierSampling = false;
        this._changePointEstimator = new Experiment;
        this._minimumComplexityEstimator = new Experiment;
        // Estimates all frames within an interval
        this._intervalFrameLengthEstimator = new Experiment;
    }, {

    // If the engine can handle the tier's complexity at the desired frame rate, test for a short
    // period, then move on to the next tier
    tierFastTestLength: 250,
    // If the engine is under stress, let the test run a little longer to let the measurement settle
    tierSlowTestLength: 750,
    // Tier intervals must have this number of non-outlier frames in order to end.
    numberOfFramesRequiredInInterval: 9,

    rampWarmupLength: 200,

    // Used for regression calculations in the ramps
    frameLengthDesired: 1000/60,
    // Add some tolerance; frame lengths shorter than this are considered to be @ the desired frame length
    frameLengthDesiredThreshold: 1000/58,
    // During tier sampling get at least this slow to find the right complexity range
    frameLengthTierThreshold: 1000/30,
    // Try to make each ramp get this slow so that we can cross the break point
    frameLengthRampLowerThreshold: 1000/45,
    // Do not let the regression calculation at the maximum complexity of a ramp get slower than this threshold
    frameLengthRampUpperThreshold: 1000/20,

    start: function(startTimestamp, stage)
    {
        console.log("RampController.start()... ");
        Controller.prototype.start.call(this, startTimestamp, stage);
        this._rampStartTimestamp = 0;
        this.intervalSamplingLength = 100;
        this._frameTimeHistory = [];
        console.log("RampController.start(), this._rampStartTimestamp = "+this._rampStartTimestamp + ",this.intervalSamplingLength = " + this.intervalSamplingLength);
    },

    registerFrameTime: function(lastFrameLength)
    {
        this._frameTimeHistory.push(lastFrameLength); //save当前帧的时间到_frameTimeHistory
    },

    intervalHasConcluded: function(timestamp)
    {
        if (!Controller.prototype.intervalHasConcluded.call(this, timestamp)) //时间上是否已到达30000+warmup+100
            return false;

        console.log("RampController.intervalHasConcluded():    this._finishedTierSampling = "+this._finishedTierSampling);
        console.log("RampController.intervalHasConcluded():    (this.filterOutOutliers(this._frameTimeHistory).length > this.numberOfFramesRequiredInInterval) = "+(this.filterOutOutliers(this._frameTimeHistory).length > this.numberOfFramesRequiredInInterval));
        return this._finishedTierSampling || this.filterOutOutliers(this._frameTimeHistory).length > this.numberOfFramesRequiredInInterval;
    },

    didFinishInterval: function(timestamp, stage, intervalAverageFrameLength)
    {
        this._frameTimeHistory = [];
        console.log("RampController.didFinishInterval(), this._tierStartTimestamp = "+this._tierStartTimestamp);
        if (!this._finishedTierSampling) {
            if (this._tierStartTimestamp > 0 && timestamp < this._tierStartTimestamp + this.tierFastTestLength) // 当前时刻timestamp < _tierStartTimestamp + tierFastTestLength(250)
                return;

            //console.log("RampController.didFinishInterval(), timestamp = "+ timestamp+", this._tierStartTimestamp + this.tierFastTestLength = "+(this._tierStartTimestamp + this.tierFastTestLength));
            var currentComplexity = stage.complexity(); //获取当前stage复杂度
            var currentFrameLength = this._frameLengthEstimator.estimate; //获取当前frame时长
            //console.log("didFinishInterval():, currentFrameLength = %d, this.frameLengthTierThreshold = %f",currentFrameLength, this.frameLengthTierThreshold);
            if (currentFrameLength < this.frameLengthTierThreshold) { //如果frame时长小于1000/30, 即33.333ms,反过来也就是当前fps > 30 Fps
                //console.log("currentFrameLength = %d", currentFrameLength);
                var isAnimatingAt60FPS = currentFrameLength < this.frameLengthDesiredThreshold;//是否还以大于等于60fps在animate，这里把条件放宽到58fps
                var hasFinishedSlowTierTest = timestamp > this._tierStartTimestamp + this.tierSlowTestLength; //判断是否完成了慢的那个tierTest,tierSlowTestLength = 750

                //console.log("isAnimatingAt60FPS = %b, hasFinishedSlowTierTest = %b", isAnimatingAt60FPS, hasFinishedSlowTierTest);
                //如果当前fps已经低于58fps，且还没有完成750的tierTest
                if (!isAnimatingAt60FPS && !hasFinishedSlowTierTest)
                    return;

                // We're measuring at 60 fps, so quickly move on to the next tier, or
                // we've slower than 60 fps, but we've let this tier run long enough to
                // get an estimate
                //console.log("currentComplexity = %f", currentComplexity);
                this._lastTierComplexity = currentComplexity;
                this._lastTierFrameLength = currentFrameLength;

                //根据currentComplexity，调整 _tier
                if (currentComplexity <= 50)
                    this._tier += 1/2;
                else if (currentComplexity <= 10000)
                    this._tier += 1/4;
                else
                    this._tier += 1/8;

                //console.log("1111111, _endTimestamp = %d, this._testLength = %d", this._endTimestamp, this._testLength);
                this._endTimestamp = timestamp + this._testLength; //this._testLength=30000 修正时间
                //console.log("1111111, _endTimestamp = %d, this._testLength = %d", this._endTimestamp, this._testLength);
                var nextTierComplexity = Math.max(Math.round(Math.pow(10, this._tier)), currentComplexity + 1);
                //console.log("nextTierComplexity = %f", nextTierComplexity);
                //这里tune的是特定场景中的物体, 比如第一个case myltiply中
                stage.tune(nextTierComplexity - currentComplexity);

                // Some tests may be unable to go beyond a certain capacity. If so, don't keep moving up tiers
                if (stage.complexity() - currentComplexity > 0 || nextTierComplexity == 1) {
                    this._tierStartTimestamp = timestamp;
                    this.mark("Complexity: " + nextTierComplexity, timestamp);
                    return;
                }
            } else if (timestamp < this._tierStartTimestamp + this.tierSlowTestLength)
                return;

            // <= 30fps
            this._finishedTierSampling = true;
            this.isFrameLengthEstimatorEnabled = false;
            this.intervalSamplingLength = 120;

            // Extend the test length so that the full test length is made of the ramps
            console.log("222222, _endTimestamp = %d, this._testLength = d%", this._endTimestamp, this._testLength);
            this._endTimestamp = timestamp + this._testLength;
            console.log("222222, _endTimestamp = %d, this._testLength = %d", this._endTimestamp, this._testLength);
            this.mark(Strings.json.samplingStartTimeOffset, timestamp);

            this._minimumComplexity = 1;
            this._possibleMinimumComplexity = this._minimumComplexity;
            this._minimumComplexityEstimator.sample(this._minimumComplexity);

            // Sometimes this last tier will drop the frame length well below the threshold.
            // Avoid going down that far since it means fewer measurements are taken in the 60 fps area.
            // Interpolate a maximum complexity that gets us around the lowest threshold.
            // Avoid doing this calculation if we never get out of the first tier (where this._lastTierComplexity is undefined).
            if (this._lastTierComplexity && this._lastTierComplexity != currentComplexity)
                this._maximumComplexity = Math.floor(Utilities.lerp(Utilities.progressValue(this.frameLengthTierThreshold, this._lastTierFrameLength, currentFrameLength), this._lastTierComplexity, currentComplexity));
            else {
                // If the browser is capable of handling the most complex version of the test, use that
                this._maximumComplexity = currentComplexity;
            }
            this._possibleMaximumComplexity = this._maximumComplexity;

            // If we get ourselves onto a ramp where the maximum complexity does not yield slow enough FPS,
            // We'll use this as a boundary to find a higher maximum complexity for the next ramp
            this._lastTierComplexity = currentComplexity;
            this._lastTierFrameLength = currentFrameLength;

            // First ramp
            console.log("First ramp......");
            stage.tune(this._maximumComplexity - currentComplexity);
            this._rampDidWarmup = false;
            // Start timestamp represents start of ramp iteration and warm up
            this._rampStartTimestamp = timestamp;
            return;
        }

        console.log("line:503 timestamp = %d, this._rampStartTimestamp = %d, this.rampWarmupLength = %d", timestamp, this._rampStartTimestamp, this.rampWarmupLength)
        if ((timestamp - this._rampStartTimestamp) < this.rampWarmupLength)
            return;

        if (this._rampDidWarmup)
            return;

        this._rampDidWarmup = true;
        this._currentRampLength = this._rampStartTimestamp + this._rampLength - timestamp;
        // Start timestamp represents start of ramp down, after warm up
        this._rampStartTimestamp = timestamp;
        this._rampStartIndex = this._sampler.sampleCount;
    },

    tune: function(timestamp, stage, lastFrameLength, didFinishInterval, intervalAverageFrameLength)
    {
        console.log("in tune(), timestamp = "+timestamp+", this._endTimestamp = "+this._endTimestamp);
        if (!this._rampDidWarmup)
            return;

        this._intervalFrameLengthEstimator.sample(lastFrameLength);
        if (!didFinishInterval)
            return;

        var currentComplexity = stage.complexity();
        var intervalFrameLengthMean = this._intervalFrameLengthEstimator.mean();
        var intervalFrameLengthStandardDeviation = this._intervalFrameLengthEstimator.standardDeviation();
        console.log("   in tune(), currentComplexity = " + currentComplexity + ", intervalFrameLengthMean = " + intervalFrameLengthMean + ", intervalFrameLengthStandardDeviation = "+intervalFrameLengthStandardDeviation);

        if (intervalFrameLengthMean < this.frameLengthDesiredThreshold && this._intervalFrameLengthEstimator.cdf(this.frameLengthDesiredThreshold) > .9) {
            this._possibleMinimumComplexity = Math.max(this._possibleMinimumComplexity, currentComplexity);
        } else if (intervalFrameLengthStandardDeviation > 2) {
            // In the case where we might have found a previous interval where 60fps was reached. We hit a significant blip,
            // so we should resample this area in the next ramp.
            this._possibleMinimumComplexity = 1;
        }
        if (intervalFrameLengthMean - intervalFrameLengthStandardDeviation > this.frameLengthRampLowerThreshold)
            this._possibleMaximumComplexity = Math.min(this._possibleMaximumComplexity, currentComplexity);
        this._intervalFrameLengthEstimator.reset();

        var progress = (timestamp - this._rampStartTimestamp) / this._currentRampLength;
        console.log(    "in tune(), progress = "+progress);
        if (progress < 1) {
            // Reframe progress percentage so that the last interval of the ramp can sample at minimum complexity
            progress = (timestamp - this._rampStartTimestamp) / (this._currentRampLength - this.intervalSamplingLength);
            stage.tune(Math.max(this._minimumComplexity, Math.floor(Utilities.lerp(progress, this._maximumComplexity, this._minimumComplexity))) - currentComplexity);
            return;
        }

        var regression = new Regression(this._sampler.samples, this._getComplexity, this._getFrameLength,
            this._sampler.sampleCount - 1, this._rampStartIndex, { desiredFrameLength: this.frameLengthDesired });
        this._rampRegressions.push(regression);

        var frameLengthAtMaxComplexity = regression.valueAt(this._maximumComplexity);
        if (frameLengthAtMaxComplexity < this.frameLengthRampLowerThreshold)
            this._possibleMaximumComplexity = Math.floor(Utilities.lerp(Utilities.progressValue(this.frameLengthRampLowerThreshold, frameLengthAtMaxComplexity, this._lastTierFrameLength), this._maximumComplexity, this._lastTierComplexity));
        // If the regression doesn't fit the first segment at all, keep the minimum bound at 1
        if ((timestamp - this._sampler.samples[0][this._sampler.sampleCount - regression.n1]) / this._currentRampLength < .25)
            this._possibleMinimumComplexity = 1;

        this._minimumComplexityEstimator.sample(this._possibleMinimumComplexity);
        this._minimumComplexity = Math.round(this._minimumComplexityEstimator.mean());

        if (frameLengthAtMaxComplexity < this.frameLengthRampUpperThreshold) {
            this._changePointEstimator.sample(regression.complexity);
            // Ideally we'll target the change point in the middle of the ramp. If the range of the ramp is too small, there isn't enough
            // range along the complexity (x) axis for a good regression calculation to be made, so force at least a range of 5
            // particles. Make it possible to increase the maximum complexity in case unexpected noise caps the regression too low.
            this._maximumComplexity = Math.round(this._minimumComplexity +
                Math.max(5,
                    this._possibleMaximumComplexity - this._minimumComplexity,
                    (this._changePointEstimator.mean() - this._minimumComplexity) * 2));
        } else {
            // The slowest samples weighed the regression too heavily
            this._maximumComplexity = Math.max(Math.round(.8 * this._maximumComplexity), this._minimumComplexity + 5);
        }

        // Next ramp
        console.log("   in tune(), Next ramp...");
        stage.tune(this._maximumComplexity - stage.complexity());
        this._rampDidWarmup = false;
        // Start timestamp represents start of ramp iteration and warm up
        this._rampStartTimestamp = timestamp;
        this._possibleMinimumComplexity = 1;
        this._possibleMaximumComplexity = this._maximumComplexity;
    },

    _getComplexity: function(samples, i) {
        return samples[1][i];
    },

    _getFrameLength: function(samples, i) {
        return samples[0][i] - samples[0][i - 1];
    },

    processSamples: function(results)
    {
        results[Strings.json.marks] = this._processMarks();
        // Have samplingTimeOffset represent time 0
        var startTimestamp = this._marks[Strings.json.samplingStartTimeOffset].time;
        for (var markName in results[Strings.json.marks]) {
            results[Strings.json.marks][markName].time -= startTimestamp;
        }

        results[Strings.json.samples] = {};

        var controllerSamples = this._processControllerSamples();
        results[Strings.json.samples][Strings.json.controller] = controllerSamples;
        controllerSamples.forEach(function(timeSample) {
            controllerSamples.setFieldInDatum(timeSample, Strings.json.time, controllerSamples.getFieldInDatum(timeSample, Strings.json.time) - startTimestamp);
        });

        // Aggregate all of the ramps into one big complexity-frameLength dataset
        var complexitySamples = new SampleData(controllerSamples.fieldMap);
        results[Strings.json.samples][Strings.json.complexity] = complexitySamples;

        results[Strings.json.controller] = [];
        this._rampRegressions.forEach(function(ramp) {
            var startIndex = ramp.startIndex, endIndex = ramp.endIndex;
            var startTime = controllerSamples.getFieldInDatum(startIndex, Strings.json.time);
            var endTime = controllerSamples.getFieldInDatum(endIndex, Strings.json.time);
            var startComplexity = controllerSamples.getFieldInDatum(startIndex, Strings.json.complexity);
            var endComplexity = controllerSamples.getFieldInDatum(endIndex, Strings.json.complexity);

            var regression = {};
            results[Strings.json.controller].push(regression);

            var percentage = (ramp.complexity - startComplexity) / (endComplexity - startComplexity);
            var inflectionTime = startTime + percentage * (endTime - startTime);

            regression[Strings.json.regressions.segment1] = [
                [startTime, ramp.s2 + ramp.t2 * startComplexity],
                [inflectionTime, ramp.s2 + ramp.t2 * ramp.complexity]
            ];
            regression[Strings.json.regressions.segment2] = [
                [inflectionTime, ramp.s1 + ramp.t1 * ramp.complexity],
                [endTime, ramp.s1 + ramp.t1 * endComplexity]
            ];
            regression[Strings.json.complexity] = ramp.complexity;
            regression[Strings.json.regressions.startIndex] = startIndex;
            regression[Strings.json.regressions.endIndex] = endIndex;
            regression[Strings.json.regressions.profile] = ramp.profile;

            for (var j = startIndex; j <= endIndex; ++j)
                complexitySamples.push(controllerSamples.at(j));
        });

        this._processComplexitySamples(complexitySamples);
    }
});

Stage = Utilities.createClass(
    function()
    {
    }, {

    initialize: function(benchmark)
    {
        this._benchmark = benchmark;
        this._element = document.getElementById("stage");
        this._element.setAttribute("width", document.body.offsetWidth);
        this._element.setAttribute("height", document.body.offsetHeight);
        this._size = Point.elementClientSize(this._element).subtract(Insets.elementPadding(this._element).size);
    },

    get element()
    {
        return this._element;
    },

    get size()
    {
        return this._size;
    },

    complexity: function()
    {
        return 0;
    },

    tune: function()
    {
        throw "Not implemented";
    },

    animate: function()
    {
        throw "Not implemented";
    },

    clear: function()
    {
        return this.tune(-this.tune(0));
    }
});

Utilities.extendObject(Stage, {
    random: function(min, max)
    {
        return (Pseudo.random() * (max - min)) + min;
    },

    randomBool: function()
    {
        return !!Math.round(Pseudo.random());
    },

    randomSign: function()
    {
        return Pseudo.random() >= .5 ? 1 : -1;
    },

    randomInt: function(min, max)
    {
        return Math.floor(this.random(min, max + 1));
    },

    randomPosition: function(maxPosition)
    {
        return new Point(this.randomInt(0, maxPosition.x), this.randomInt(0, maxPosition.y));
    },

    randomSquareSize: function(min, max)
    {
        var side = this.random(min, max);
        return new Point(side, side);
    },

    randomVelocity: function(maxVelocity)
    {
        return this.random(maxVelocity / 8, maxVelocity);
    },

    randomAngle: function()
    {
        return this.random(0, Math.PI * 2);
    },

    randomColor: function()
    {
        var min = 32;
        var max = 256 - 32;
        return "#"
            + this.randomInt(min, max).toString(16)
            + this.randomInt(min, max).toString(16)
            + this.randomInt(min, max).toString(16);
    },

    randomStyleMixBlendMode: function()
    {
        var mixBlendModeList = [
          'normal',
          'multiply',
          'screen',
          'overlay',
          'darken',
          'lighten',
          'color-dodge',
          'color-burn',
          'hard-light',
          'soft-light',
          'difference',
          'exclusion',
          'hue',
          'saturation',
          'color',
          'luminosity'
        ];

        return mixBlendModeList[this.randomInt(0, mixBlendModeList.length)];
    },

    randomStyleFilter: function()
    {
        var filterList = [
            'grayscale(50%)',
            'sepia(50%)',
            'saturate(50%)',
            'hue-rotate(180)',
            'invert(50%)',
            'opacity(50%)',
            'brightness(50%)',
            'contrast(50%)',
            'blur(10px)',
            'drop-shadow(10px 10px 10px gray)'
        ];

        return filterList[this.randomInt(0, filterList.length)];
    },

    randomElementInArray: function(array)
    {
        return array[Stage.randomInt(0, array.length - 1)];
    },

    rotatingColor: function(cycleLengthMs, saturation, lightness)
    {
        return "hsl("
            + Stage.dateFractionalValue(cycleLengthMs) * 360 + ", "
            + ((saturation || .8) * 100).toFixed(0) + "%, "
            + ((lightness || .35) * 100).toFixed(0) + "%)";
    },

    // Returns a fractional value that wraps around within [0,1]
    dateFractionalValue: function(cycleLengthMs)
    {
        return (Date.now() / (cycleLengthMs || 2000)) % 1;
    },

    // Returns an increasing value slowed down by factor
    dateCounterValue: function(factor)
    {
        return Date.now() / factor;
    },

    randomRotater: function()
    {
        return new Rotater(this.random(1000, 10000));
    }
});

Rotater = Utilities.createClass(
    function(rotateInterval)
    {
        this._timeDelta = 0;
        this._rotateInterval = rotateInterval;
        this._isSampling = false;
    }, {

    get interval()
    {
        return this._rotateInterval;
    },

    next: function(timeDelta)
    {
        this._timeDelta = (this._timeDelta + timeDelta) % this._rotateInterval;
    },

    degree: function()
    {
        return (360 * this._timeDelta) / this._rotateInterval;
    },

    rotateZ: function()
    {
        return "rotateZ(" + Math.floor(this.degree()) + "deg)";
    },

    rotate: function(center)
    {
        return "rotate(" + Math.floor(this.degree()) + ", " + center.x + "," + center.y + ")";
    }
});

Benchmark = Utilities.createClass(
    function(stage, options)
    {
        this._animateLoop = this._animateLoop.bind(this);
        this._warmupLength = options["warmup-length"];
        console.log("this._warmupLength = %d", this._warmupLength);
        this._frameCount = 0;
        this._warmupFrameCount = options["warmup-frame-count"];
        this._firstFrameMinimumLength = options["first-frame-minimum-length"];

        this._stage = stage;
        this._stage.initialize(this, options);

        switch (options["time-measurement"])
        {
        case "performance":
            if (window.performance && window.performance.now)
                this._getTimestamp = performance.now.bind(performance);
            else
                this._getTimestamp = null;
            break;
        case "raf":
            this._getTimestamp = null;
            break;
        case "date":
            this._getTimestamp = Date.now;
            break;
        }

        options["test-interval"] *= 1000;
        switch (options["controller"])
        {
        case "fixed":
            this._controller = new FixedController(this, options);
            break;
        case "adaptive":
            this._controller = new AdaptiveController(this, options);
            break;
        case "ramp":
            this._controller = new RampController(this, options);
            break;
        }
    }, {

    get stage()
    {
        return this._stage;
    },

    get timestamp()
    {
        return this._currentTimestamp - this._benchmarkStartTimestamp;
    },

    backgroundColor: function()
    {
        var stage = window.getComputedStyle(document.getElementById("stage"));
        return stage["background-color"];
    },

    run: function()
    {
        return this.waitUntilReady().then(function() {
            this._finishPromise = new SimplePromise;
            this._previousTimestamp = undefined;
            this._didWarmUp = false;
            //console.log("this._controller.initialComplexity = %d", this._controller.initialComplexity);
            this._stage.tune(this._controller.initialComplexity - this._stage.complexity());
            this._animateLoop();
            return this._finishPromise;
        }.bind(this));
    },

    // Subclasses should override this if they have setup to do prior to commencing.
    waitUntilReady: function()
    {
        var promise = new SimplePromise;
        promise.resolve();
        return promise;
    },

    _animateLoop: function(timestamp)
    {
        console.log("this._testLength = " + this._testLength);
        //console.log("1, timestamp = %d", timestamp);
        timestamp = (this._getTimestamp && this._getTimestamp()) || timestamp;
        //console.log("2, timestamp = %d", timestamp);
        this._currentTimestamp = timestamp;
        //console.log("3, this._currentTimestamp = %d", this._currentTimestamp);

        //overall的控制条件，一旦每个case跑满30000ms即30s就停止
        if (this._controller.shouldStop(timestamp)) {
            this._finishPromise.resolve(this._controller.results());
            return;
        }

        if (!this._didWarmUp) {
            //开始计时
            console.log("timestamp = " + timestamp + ", this._frameCount = " + this._frameCount);
            console.log("this._warmupLength = " + this._warmupLength + ", this._warmupFrameCount = " + this._warmupFrameCount);
            if (!this._previousTimestamp) {
                this._previousTimestamp = timestamp;
                this._benchmarkStartTimestamp = timestamp;
            }
            //判断是否到达warmup的时间并且帧数超过warmup的帧数
            else if (timestamp - this._previousTimestamp >= this._warmupLength && this._frameCount >= this._warmupFrameCount) {
                this._didWarmUp = true;
                console.log("warm up is done!");

                this._benchmarkStartTimestamp = timestamp;//修正记录benchmark开始的时间
                this._controller.start(timestamp, this._stage);//修正benchmark结束的时间,算上warmup的部分;计算averageFrameLength;记录数据
                this._previousTimestamp = timestamp;
                console.log("this._firstFrameMinimumLength = " + this._firstFrameMinimumLength);
                while (this._getTimestamp && this._getTimestamp() - timestamp < this._firstFrameMinimumLength) {
                }
            }
            //如果warmup还未完成,继续warmup
            this._stage.animate(0);
            ++this._frameCount;
            requestAnimationFrame(this._animateLoop);
            return;
        }

        console.log("timestamp = " + timestamp + ", this._intervalEndTimestamp = " + this._intervalEndTimestamp);

        this._controller.update(timestamp, this._stage);
        console.log("after done this._controller.update(), timestamp = " + timestamp + ", this._endTimestamp = " + this._endTimestamp);

        console.log("before this._stage.animate(), timestamp - this._previousTimestamp ="+(timestamp - this._previousTimestamp));
        this._stage.animate(timestamp - this._previousTimestamp);


        this._previousTimestamp = timestamp;

        console.log("requestAnimationFrame(this._animateLoop)");
        requestAnimationFrame(this._animateLoop);
        console.log("                        ");
    }
});
