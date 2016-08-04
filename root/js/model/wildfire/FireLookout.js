/* 
 * Copyright (c) 2015, 2016 Bruce Schubert.
 * The MIT License.
 */

/*global define, $*/

define(['require',
    'knockout',
    'model/wildire/FuelModelCatalog',
    'model/wildire/FuelMoistureCatalog',
    'model/services/LandfireResource',
    'model/util/Log',
    'wmt/resource/SolarResource',
    'model/services/SurfaceFireResource',
    'model/services/SurfaceFuelResource',
    'model/globe/Terrain',
    'model/services/TerrainResource',
    'model/services/WeatherService',
    'model/weather/WeatherScout',
    'model/util/WmtUtil',
    'wmt/Wmt'],
    function (
        require,
        ko,
        fuelModelCatalog,
        fuelMoistureCatalog,
        landfireResource,
        log,
        solarResource,
        surfaceFireResource,
        surfaceFuelResource,
        Terrain,
        terrainResource,
        weatherResource,
        WeatherScout,
        util,
        wmt) {
        "use strict";


        /**
         * Creates a FireLookout.
         * @constructor
         * @param {Object} params
         * @returns {FireLookout}
         */
        var FireLookout = function (params) {
            var args = params || {},
                self = this,
                model = require("wmt/controller/Controller").model;

            // FireLookout inherits the weather forecasting capabilites of the WeatherScout
            WeatherScout.call(this, params);

            /**
             * Override the WeatherScout name set by the parent
             */
            this.name(args.name || 'Fire Lookout');
            this.toponym(args.toponym);

            /**
             * Override the parent WeatherScout's Openable implementation with a FireLookoutDialog
             */
            this.openMe = function () {
                   var $element = $("#fire-lookout-editor"),        
                        editorViewModel = ko.dataFor($element.get(0)); // get the view model bound to the element
                    
                    if (editorViewModel) {
                        editorViewModel.open(this);
                        return true; // return true to fire EVENT_OBJECT_OPENED event.
                    }
                    log.warning("FireLookout", "openMe", "#fire-lookout-editor element was not found.")
                    return false;             
                };

            // Persistent properties
            this.fuelModelNo = args.fuelModelNo || wmt.configuration.defaultFuelModelNo;
            this.fuelModelManualSelect = args.fuelModelManualSelect || false;
            this.moistureScenarioName = args.moistureScenarioName || wmt.configuration.defaultFuelMoistureScenario;

            // Dynamic properties
            this.sunlight = model.sunlight;
            this.terrain = Terrain.ZERO;
            this.surfaceFuel = null;

            // Internals
            this.refreshInProgress = false;
            this.refreshPending = false;


            // Self subscribe to weather updates generated by parent so we can update the fire behavior
            this.on(wmt.EVENT_WEATHER_CHANGED, this.refreshFireBehavior, this);
            // Self subscribe to place updates generated by parent so we can update the fire behavior
            this.on(wmt.EVENT_PLACE_CHANGED, this.refreshFuelModel, this);
            // Subscribe to applicaiton time events so we can update the fire behavior.
            model.on(wmt.EVENT_TIME_CHANGED, this.refreshFireBehavior, this);

        };
        FireLookout.prototype = Object.create(WeatherScout.prototype);

        Object.defineProperties(FireLookout.prototype, {
            /**
             * The fuel model number determines the fuel model object.
             */
            fuelModelNo: {
                get: function () {
                    return this.fuelModel.modelNo;
                },
                set: function (value) {
                    this.fuelModel = fuelModelCatalog.getFuelModel(value);
                }
            },
            /**
             * The fuel moisture scenario determines the fuel moisture object.
             */
            moistureScenarioName: {
                get: function () {
                    return this.moistureScenario.name;
                },
                set: function (value) {
                    this.moistureScenario = fuelMoistureCatalog.getScenario(value);
                    this.fuelMoisture = this.moistureScenario.fuelMoisture;
                }
            }
        });

        FireLookout.prototype.refreshFuelModel = function () {
            if (this.fuelModelManualSelect) {
                return;
            }
            var self = this;
            try {
                landfireResource.FBFM13(this.latitude, this.longitude, function (fuelModelNo) {
                    self.fuelModel = fuelModelCatalog.getFuelModel(parseInt(fuelModelNo, 10));
                    self.refreshFireBehavior();
                });
            } catch (e) {
                //messenger.warningGrowl("The automated fuel model lookup is service unavailable. You must manually select the fuel model.");
                log.warning('FireLookout','refreshFuelModel',e.message);
            }


        };

        /**
         * Updates the weather lookout's weather forecast and location, 
         * Then updates this derived object's fire behavior.
         */
        FireLookout.prototype.refreshFireBehavior = function () {
            if (!this.fuelModel || !this.fuelMoisture) {
                log.error('FireLookout', 'refresh', 'fuelModel and/or fuelMoisture is null.');
                return;
            }
            // Don't queue multiple requests. If a request comes in then 
            // just fire an immediate refresh after the current one finishes.
            if (this.refreshInProgress) {
                this.refreshPending = true;
                return;
            }
            this.refreshInProgress = true;
            // Note: using require() to get around circular dependency with Controller.
            var self = this,
                model = require("wmt/controller/Controller").model,
                globe = model.globe,
                deferredSunlight = $.Deferred(),
                deferredFuel = $.Deferred(),
                weatherTuple,
                terrainTuple,
                shaded = 'false';

            // Create a weather tuple for the current applciation time
            this.activeWeather = this.getForecastAtTime(model.applicationTime);
            weatherTuple = weatherResource.makeTuple(self.activeWeather);
            // Refresh Terrain
            this.terrain = globe.getTerrainAtLatLon(this.latitude, this.longitude);
            terrainTuple = terrainResource.makeTuple(this.terrain.aspect, this.terrain.slope, this.terrain.elevation);

            // Get the sunlight at this time and place,
            // resolving deferredSunlight when done.
            this.refreshSunlight(deferredSunlight);

            // Get conditioned fuel using current environmental values
            // after the deferred sunlight is resolved
            $.when(deferredSunlight).done(function (resolvedSunlight) {

                // Get conditioned fuel at this location,
                // resolving deferredFuel when complete
                self.refreshSurfaceFuel(
                    self.fuelModel,
                    resolvedSunlight,
                    weatherTuple,
                    terrainTuple,
                    shaded,
                    self.fuelMoisture,
                    deferredFuel);
            });

            // Compute the fire behavior after the 
            // conditioned fuel is resolved.
            $.when(deferredFuel).done(function (resolvedFuel) {
                if (resolvedFuel === null) { // null on failure
                    self.refreshInProgress = false;
                    return;
                }
                // Retrieve the computed fire behavior using 
                // conditioned fuel, weather and terrain.
                surfaceFireResource.surfaceFire(
                    resolvedFuel, weatherTuple, terrainTuple,
                    function (json) {
                        //Callback to process JSON result
                        //log.info('FireLookout', 'refresh-deferred', JSON.stringify(json));
                        self.surfaceFire = json;

                        log.info('FireLookout', 'refreshFireBehavior', self.name + ': EVENT_FIRE_BEHAVIOR_CHANGED');
                        self.fire(wmt.EVENT_FIRE_BEHAVIOR_CHANGED, self);

                        // Fire off another refresh if a request was queued 
                        // while this request was being fullfilled.
                        self.refreshInProgress = false;
                        if (self.refreshPending) {
                            self.refreshPending = false;
                            setTimeout(self.refreshFireBehavior(), 0);
                        }
                    }
                );
            });
        };


        /**
         * Retrieves a Sunlight object from the REST service. Resolves the
         * optional Deferred object with this object's sunlight property.
         * 
         * @param {$.Deferred} deferred Deferred object that resolves with a sunlight object 
         * when the query and processing is complete.
         */
        FireLookout.prototype.refreshSunlight = function (deferred) {
            var self = this,
                model = require("wmt/controller/Controller").model;

            // Get the sunlight at this time and location
            solarResource.sunlightAtLatLonTime(this.latitude, this.longitude, model.applicationTime,
                function (json) { // Callback to process JSON result
                    self.sunlight = json;
                    if (deferred) {
                        deferred.resolve(self.sunlight);
                    }
                });

        };
        /**
         * Retrieves a SurfaceFuel object from the REST service. Resolves the optional 
         * Deferred object with this object's surfaceFuel property.
         * 
         * @param {type} fuelModel
         * @param {type} sunlight
         * @param {type} weatherTuple
         * @param {type} terrainTuple
         * @param {type} shaded
         * @param {type} fuelMoisture
         * @param {$.Deferred} deferredFuel Deferred object that is resolved with the surface fuel 
         * when the query and processing are complete.
         */
        FireLookout.prototype.refreshSurfaceFuel = function (fuelModel, sunlight, weatherTuple, terrainTuple, shaded,
            fuelMoisture, deferredFuel) {
            var self = this;
            // Get the conditioned fuel at this location
            surfaceFuelResource.conditionedSurfaceFuel(
                fuelModel, sunlight, weatherTuple, terrainTuple, shaded, fuelMoisture,
                function (json, textStatus, jqXHR) { // Callback to process JSON result
                    //log.info('FireLookout', 'processSurfaceFuel', JSON.stringify(json));
                    self.surfaceFuel = json;
                    if (deferredFuel) {
                        deferredFuel.resolve(self.surfaceFuel);
                    }
                });

        };

        return FireLookout;

    }

);

