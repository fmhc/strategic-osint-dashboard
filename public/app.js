        // ============================================
        // CESIUM GLOBE WITH REAL MAP
        // ============================================
        
        // Use default Ion token (limited but works for demo)
        // Optional: set your own Cesium Ion token for Ion-hosted assets/terrain.
        // Not required for the CartoDB basemap this app uses by default.
        // Cesium.Ion.defaultAccessToken = 'YOUR_CESIUM_ION_TOKEN';
        
        // Initialize viewer with OpenStreetMap
        const viewer = new Cesium.Viewer('cesiumContainer', {
            baseLayerPicker: false,
            geocoder: false,
            homeButton: false,
            sceneModePicker: false,
            selectionIndicator: false,
            timeline: false,
            animation: false,
            navigationHelpButton: false,
            fullscreenButton: false,
            vrButton: false,
            infoBox: false,
            imageryProvider: false, // We'll add manually
            // Render on demand instead of a continuous 60fps loop → ~30-50% GPU saving
            // when idle. Camera moves, entity add/remove and entity property changes
            // (incl. the dataflow packet position updates) auto-request a render, so the
            // globe stays live. The only continuous animation (clock-based sun/moon
            // simulation) toggles this off while active — see the daynight toggle.
            requestRenderMode: true,
            maximumRenderTimeChange: Infinity
        });
        
        // Remove default imagery and add CartoDB Dark (better for data visualization)
        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(
            new Cesium.UrlTemplateImageryProvider({
                url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
                maximumLevel: 19,
                credit: 'CartoDB Dark Matter'
            })
        );
        
        // Dark space background  
        viewer.scene.backgroundColor = Cesium.Color.BLACK;
        viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1a1a2e');
        
        // Atmosphere
        viewer.scene.globe.enableLighting = false;
        viewer.scene.skyAtmosphere.show = true;

        // 3D perf tuning: cap tile detail (fewer tiles → less load/bandwidth/GPU)
        // and bound the tile cache. resolutionScale gives a manual perf mode for
        // weaker GPUs. (Adaptive-by-FPS is intentionally omitted: requestRenderMode
        // renders on demand, so a continuous FPS sampler would be misleading.)
        viewer.scene.globe.maximumScreenSpaceError = 2.5; // default 2; 2.5 ≈ slightly fewer tiles
        viewer.scene.globe.tileCacheSize = 100;
        viewer.resolutionScale = 1.0;
        // Occlude markers/arcs on the far side of the globe (depth-test against it)
        viewer.scene.globe.depthTestAgainstTerrain = true;
        let perfMode = false;
        function togglePerfMode() {
            perfMode = !perfMode;
            viewer.resolutionScale = perfMode ? 0.6 : 1.0;
            viewer.scene.globe.maximumScreenSpaceError = perfMode ? 4 : 2.5;
            const btn = document.getElementById('btn-perf');
            if (btn) btn.style.background = perfMode ? 'var(--accent)' : '';
            if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
        }

        // Initial view - Global
        viewer.camera.setView({
            destination: Cesium.Cartesian3.fromDegrees(20, 30, 25000000)
        });
        
        // Track entities
        const flightEntities = new Map();
        const flightRoutes = new Map();      // Store route polylines
        const flightHistory = new Map();     // Store position history for trails
        const earthquakeEntities = new Map();
        const baseEntities = new Map();

        // Maritime infrastructure entities
        const platformEntities = new Map();
        const cableEntities = [];
        const landingPointEntities = new Map();
        const aisVesselEntities = new Map();
        let submarineCablesLoaded = false;
        let maritimeLayersVisible = {
            platforms: true,
            cables: true,
            landingPoints: false,
            aisVessels: true
        };

        // ============================================
        // HIGH-PERFORMANCE STATIC LAYERS (Primitives)
        // ============================================
        // Using Cesium Primitives API for 10x better performance on static data

        const staticLayers = {
            // Primitive collections (much faster than Entities)
            cableCollection: null,
            cablePrimitives: [],
            cableData: [],  // Store raw data for click detection

            // State
            cablesVisible: true,
            cablesLoaded: false,

            // Initialize primitive collections
            init() {
                // Add GroundPolylinePrimitive collection for cables
                this.cableCollection = new Cesium.PrimitiveCollection();
                viewer.scene.primitives.add(this.cableCollection);
                console.log('[STATIC] High-performance primitive layers initialized');
            },

            // Load cables as primitives (much faster than entities)
            loadCablesAsPrimitives(cablesGeoJSON) {
                if (!cablesGeoJSON || !cablesGeoJSON.features) return;

                console.log(`[STATIC] Loading ${cablesGeoJSON.features.length} cables as primitives...`);
                const startTime = performance.now();

                // Clear existing
                this.clearCables();

                // Group cables for batch processing
                const activeCables = [];
                const plannedCables = [];

                cablesGeoJSON.features.forEach(cable => {
                    if (!cable.geometry || !cable.geometry.coordinates) return;

                    const isPlanned = cable.properties?.is_planned;
                    const coords = cable.geometry.coordinates;
                    const isMulti = cable.geometry.type === 'MultiLineString';
                    const segments = isMulti ? coords : [coords];

                    segments.forEach(segment => {
                        const positions = [];
                        segment.forEach(coord => {
                            if (Array.isArray(coord) && coord.length >= 2) {
                                positions.push(Cesium.Cartesian3.fromDegrees(coord[0], coord[1]));
                            }
                        });

                        if (positions.length >= 2) {
                            const cableEntry = {
                                positions,
                                properties: cable.properties,
                                isPlanned
                            };

                            if (isPlanned) {
                                plannedCables.push(cableEntry);
                            } else {
                                activeCables.push(cableEntry);
                            }

                            this.cableData.push(cableEntry);
                        }
                    });
                });

                // Create primitive instances for active cables (green glow)
                if (activeCables.length > 0) {
                    const activeInstances = activeCables.map(c =>
                        new Cesium.GeometryInstance({
                            geometry: new Cesium.PolylineGeometry({
                                positions: c.positions,
                                width: 3.0,
                                vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT
                            }),
                            attributes: {
                                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                                    Cesium.Color.fromCssColorString('#00ff88').withAlpha(0.7)
                                )
                            }
                        })
                    );

                    const activePrimitive = new Cesium.Primitive({
                        geometryInstances: activeInstances,
                        appearance: new Cesium.PolylineMaterialAppearance({
                            material: Cesium.Material.fromType('PolylineGlow', {
                                color: Cesium.Color.fromCssColorString('#00ff88'),
                                glowPower: 0.2
                            })
                        }),
                        asynchronous: true  // Non-blocking load
                    });

                    this.cableCollection.add(activePrimitive);
                    this.cablePrimitives.push(activePrimitive);
                }

                // Create primitive instances for planned cables (gray)
                if (plannedCables.length > 0) {
                    const plannedInstances = plannedCables.map(c =>
                        new Cesium.GeometryInstance({
                            geometry: new Cesium.PolylineGeometry({
                                positions: c.positions,
                                width: 2.0,
                                vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT
                            }),
                            attributes: {
                                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                                    Cesium.Color.fromCssColorString('#666666').withAlpha(0.5)
                                )
                            }
                        })
                    );

                    const plannedPrimitive = new Cesium.Primitive({
                        geometryInstances: plannedInstances,
                        appearance: new Cesium.PolylineMaterialAppearance({
                            material: Cesium.Material.fromType('PolylineGlow', {
                                color: Cesium.Color.GRAY,
                                glowPower: 0.1
                            })
                        }),
                        asynchronous: true
                    });

                    this.cableCollection.add(plannedPrimitive);
                    this.cablePrimitives.push(plannedPrimitive);
                }

                this.cablesLoaded = true;
                const elapsed = (performance.now() - startTime).toFixed(1);
                console.log(`[STATIC] Loaded ${activeCables.length} active + ${plannedCables.length} planned cables as primitives in ${elapsed}ms`);
            },

            // Toggle cable visibility (instant, no re-render)
            setCablesVisible(visible) {
                this.cablesVisible = visible;
                this.cableCollection.show = visible;
            },

            // Clear all cables
            clearCables() {
                this.cableCollection.removeAll();
                this.cablePrimitives = [];
                this.cableData = [];
                this.cablesLoaded = false;
            },

            // Get cable at screen position (for click/hover)
            getCableAtPosition(windowPosition) {
                // Note: Primitives don't support picking by default
                // For now, return null - would need ray intersection
                return null;
            }
        };

        // Initialize static layers after viewer is ready
        staticLayers.init();

        // ============================================
        // DATA FLOW ANIMATION SYSTEM
        // ============================================
        // Animated particles on cables and arcs between IXPs
        // Speed/color reactive to real-time internet health

        const dataFlowSystem = {
            enabled: true,
            healthData: null,
            cableParticles: [],
            ixpArcs: [],
            arcEntities: [],
            packetEntities: [],
            animationFrame: null,
            lastUpdate: 0,

            // Animation settings (reactive to health)
            settings: {
                particleSpeed: 0.002,      // Base speed (adjusted by health)
                particleCount: 500,         // Max particles on cables
                arcPacketCount: 50,         // Packets per arc
                healthyColor: '#00ff88',
                degradedColor: '#ffaa00',
                criticalColor: '#ff3333',
                refreshInterval: 5000       // Health data refresh
            },

            // Initialize data flow visualization
            async init() {
                console.log('[DATAFLOW] Initializing data flow animation system...');
                await this.loadHealthData();
                this.createIXPArcs();
                this.startAnimation();

                // Fallback: Refresh health data periodically if WebSocket isn't updating
                // (WebSocket updates are preferred and handled via socket.on('internet-health-update'))
                setInterval(() => {
                    // Only fetch if no recent update via WebSocket
                    const timeSinceUpdate = Date.now() - (this.healthData?.timestamp ? new Date(this.healthData.timestamp).getTime() : 0);
                    if (timeSinceUpdate > 120000) { // 2 min without update
                        this.loadHealthData();
                    }
                }, 60000); // Check every minute
            },

            // Load internet health status
            async loadHealthData() {
                try {
                    const res = await fetch('/api/internet-health');
                    this.healthData = await res.json();

                    // Update animation based on health
                    this.updateAnimationFromHealth();

                    console.log(`[DATAFLOW] Health score: ${this.healthData.healthScore}%, Status: ${this.healthData.status}`);
                } catch (error) {
                    console.error('[DATAFLOW] Health data fetch error:', error);
                    // Use defaults on error
                    this.healthData = { healthScore: 85, status: 'degraded', ixpConnections: [], cableStatus: [] };
                }
            },

            // Adjust animation parameters based on health
            updateAnimationFromHealth() {
                if (!this.healthData) return;

                const score = this.healthData.healthScore;

                // Particle speed: faster when healthy, slower when degraded
                this.settings.particleSpeed = score >= 90 ? 0.003 :
                                              score >= 70 ? 0.002 :
                                              score >= 50 ? 0.001 : 0.0005;

                // Update arc colors based on connection status
                this.updateArcColors();
            },

            // Create animated arcs between IXPs
            createIXPArcs() {
                // Clear existing arcs
                this.arcEntities.forEach(e => viewer.entities.remove(e));
                this.arcEntities = [];
                this.packetEntities.forEach(e => viewer.entities.remove(e));
                this.packetEntities = [];

                if (!this.healthData?.ixpConnections) return;

                this.healthData.ixpConnections.forEach((conn, idx) => {
                    if (!conn.from.lat || !conn.to.lat) return;

                    // Create arc geometry (great circle path)
                    const arcPoints = this.calculateArcPoints(
                        conn.from.lon, conn.from.lat,
                        conn.to.lon, conn.to.lat,
                        50 // Number of points
                    );

                    // Determine color based on status
                    const color = conn.status === 'operational' ? this.settings.healthyColor :
                                 conn.status === 'degraded' ? this.settings.degradedColor :
                                 this.settings.criticalColor;

                    // Create arc polyline (elevated above surface)
                    const arcEntity = viewer.entities.add({
                        name: `arc-${conn.id}`,
                        polyline: {
                            positions: arcPoints,
                            width: 2,
                            material: new Cesium.PolylineGlowMaterialProperty({
                                glowPower: 0.3,
                                color: Cesium.Color.fromCssColorString(color).withAlpha(0.6)
                            }),
                            clampToGround: false
                        }
                    });
                    arcEntity.customData = { type: 'dataArc', connection: conn };
                    this.arcEntities.push(arcEntity);

                    // Store arc data for packet animation
                    this.ixpArcs.push({
                        id: conn.id,
                        points: arcPoints,
                        connection: conn,
                        packets: this.createPacketsForArc(arcPoints, conn)
                    });
                });

                console.log(`[DATAFLOW] Created ${this.arcEntities.length} IXP connection arcs`);
            },

            // Calculate arc points with elevation
            calculateArcPoints(lon1, lat1, lon2, lat2, numPoints) {
                const points = [];
                const distance = Cesium.Cartesian3.distance(
                    Cesium.Cartesian3.fromDegrees(lon1, lat1),
                    Cesium.Cartesian3.fromDegrees(lon2, lat2)
                );

                // Arc height based on distance (higher for longer routes)
                const maxHeight = Math.min(distance * 0.15, 2000000); // Max 2000km height

                for (let i = 0; i <= numPoints; i++) {
                    const t = i / numPoints;

                    // Interpolate position
                    const lon = lon1 + (lon2 - lon1) * t;
                    const lat = lat1 + (lat2 - lat1) * t;

                    // Parabolic height curve
                    const height = maxHeight * Math.sin(Math.PI * t);

                    points.push(Cesium.Cartesian3.fromDegrees(lon, lat, height));
                }

                return points;
            },

            // Create animated packet entities for an arc
            createPacketsForArc(arcPoints, conn) {
                const packets = [];
                const packetCount = Math.min(5, Math.ceil(conn.traffic?.utilization / 20) || 2);

                for (let i = 0; i < packetCount; i++) {
                    const packet = {
                        progress: Math.random(), // 0-1 position along arc
                        speed: this.getPacketSpeed(conn),
                        direction: Math.random() > 0.5 ? 1 : -1, // Bidirectional
                        entity: null
                    };

                    // Create packet entity
                    const color = conn.status === 'operational' ?
                        Cesium.Color.fromCssColorString('#00ffff') :
                        Cesium.Color.fromCssColorString('#ffaa00');

                    packet.entity = viewer.entities.add({
                        name: `packet-${conn.id}-${i}`,
                        position: arcPoints[0],
                        point: {
                            pixelSize: 6,
                            color: color,
                            outlineColor: Cesium.Color.WHITE,
                            outlineWidth: 1,
                            scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 1e7, 0.3),
                            disableDepthTestDistance: 0
                        }
                    });
                    packet.entity.customData = { type: 'dataPacket', connection: conn };

                    packets.push(packet);
                    this.packetEntities.push(packet.entity);
                }

                return packets;
            },

            // Get packet speed based on connection status
            getPacketSpeed(conn) {
                const baseSpeed = this.settings.particleSpeed;
                if (conn.status === 'down') return 0;
                if (conn.status === 'degraded') return baseSpeed * 0.5;
                return baseSpeed * (0.8 + Math.random() * 0.4);
            },

            // Update arc colors based on current health
            // Pre-allocated glow materials (max 3: healthy/degraded/critical) reused
            // across all arcs and every health update instead of recreating per arc.
            _arcMaterial(status) {
                const key = status === 'operational' ? 'healthy' : status === 'degraded' ? 'degraded' : 'critical';
                if (!this._arcMaterials) this._arcMaterials = {};
                if (!this._arcMaterials[key]) {
                    const color = key === 'healthy' ? this.settings.healthyColor :
                                  key === 'degraded' ? this.settings.degradedColor :
                                  this.settings.criticalColor;
                    this._arcMaterials[key] = new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.3,
                        color: Cesium.Color.fromCssColorString(color).withAlpha(0.6)
                    });
                }
                return this._arcMaterials[key];
            },

            updateArcColors() {
                if (!this.healthData?.ixpConnections) return;

                this.ixpArcs.forEach(arc => {
                    const conn = this.healthData.ixpConnections.find(c => c.id === arc.id);
                    if (conn && arc.packets) {
                        // Update arc entity color (reuse pre-allocated material)
                        const arcEntity = this.arcEntities.find(e =>
                            e.customData?.connection?.id === arc.id
                        );
                        if (arcEntity?.polyline) {
                            arcEntity.polyline.material = this._arcMaterial(conn.status);
                        }

                        // Update packet speeds
                        arc.packets.forEach(p => {
                            p.speed = this.getPacketSpeed(conn);
                        });
                    }
                });
            },

            // Main animation loop
            startAnimation() {
                const animate = (timestamp) => {
                    if (!this.enabled) {
                        this.animationFrame = requestAnimationFrame(animate);
                        return;
                    }

                    const deltaTime = timestamp - this.lastUpdate;
                    this.lastUpdate = timestamp;

                    // Animate packets along arcs
                    this.ixpArcs.forEach(arc => {
                        if (!arc.packets || arc.points.length < 2) return;

                        arc.packets.forEach(packet => {
                            if (packet.speed === 0) return;

                            // Update progress
                            packet.progress += packet.speed * packet.direction;

                            // Wrap around
                            if (packet.progress > 1) packet.progress = 0;
                            if (packet.progress < 0) packet.progress = 1;

                            // Calculate position along arc
                            const idx = Math.floor(packet.progress * (arc.points.length - 1));
                            const nextIdx = Math.min(idx + 1, arc.points.length - 1);
                            const localT = (packet.progress * (arc.points.length - 1)) - idx;

                            // Interpolate between points
                            const pos = Cesium.Cartesian3.lerp(
                                arc.points[idx],
                                arc.points[nextIdx],
                                localT,
                                new Cesium.Cartesian3()
                            );

                            // Update entity position
                            if (packet.entity) {
                                packet.entity.position = pos;
                            }
                        });
                    });

                    this.animationFrame = requestAnimationFrame(animate);
                };

                this.animationFrame = requestAnimationFrame(animate);
                console.log('[DATAFLOW] Animation started');
            },

            // Toggle data flow visualization
            toggle() {
                this.enabled = !this.enabled;
                this.arcEntities.forEach(e => {
                    if (e.polyline) e.polyline.show = this.enabled;
                });
                this.packetEntities.forEach(e => {
                    if (e.point) e.point.show = this.enabled;
                });
                console.log(`[DATAFLOW] ${this.enabled ? 'Enabled' : 'Disabled'}`);
                return this.enabled;
            },

            // Get current status for UI
            getStatus() {
                return {
                    enabled: this.enabled,
                    healthScore: this.healthData?.healthScore || 0,
                    status: this.healthData?.status || 'unknown',
                    activeArcs: this.arcEntities.length,
                    activePackets: this.packetEntities.length,
                    activeIssues: this.healthData?.activeIssues?.length || 0
                };
            },

            // Cleanup
            destroy() {
                if (this.animationFrame) {
                    cancelAnimationFrame(this.animationFrame);
                }
                this.arcEntities.forEach(e => viewer.entities.remove(e));
                this.packetEntities.forEach(e => viewer.entities.remove(e));
            }
        };

        // Initialize data flow after a short delay (wait for other systems)
        setTimeout(() => dataFlowSystem.init(), 3000);

        // ============================================
        // CLUSTERING FOR POINT DATA
        // ============================================
        // Group nearby points when zoomed out with count badges

        // Create clustered data source for platforms
        const platformClusterSource = new Cesium.CustomDataSource('platforms-clustered');
        platformClusterSource.clustering.enabled = true;
        platformClusterSource.clustering.pixelRange = 50;  // Group within 50px
        platformClusterSource.clustering.minimumClusterSize = 3;  // Min 3 to cluster
        platformClusterSource.clustering.clusterBillboards = true;
        platformClusterSource.clustering.clusterLabels = true;
        platformClusterSource.clustering.clusterPoints = true;

        // Custom cluster style
        platformClusterSource.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
            cluster.billboard.show = true;
            cluster.label.show = true;
            cluster.label.text = clusteredEntities.length.toString();
            cluster.label.font = '600 14px JetBrains Mono';
            cluster.label.fillColor = Cesium.Color.WHITE;
            cluster.label.outlineColor = Cesium.Color.fromCssColorString('#ff6600');
            cluster.label.outlineWidth = 2;
            cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
            cluster.label.pixelOffset = new Cesium.Cartesian2(0, 0);
            cluster.label.disableDepthTestDistance = 0;

            // Cluster icon based on count
            const count = clusteredEntities.length;
            const size = count > 50 ? 40 : count > 20 ? 32 : count > 10 ? 28 : 24;

            // Create cluster icon
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            // Draw cluster circle
            ctx.beginPath();
            ctx.arc(size/2, size/2, size/2 - 2, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255, 102, 0, 0.8)';
            ctx.fill();
            ctx.strokeStyle = '#ff9500';
            ctx.lineWidth = 2;
            ctx.stroke();

            cluster.billboard.image = canvas.toDataURL();
            cluster.billboard.width = size;
            cluster.billboard.height = size;
            cluster.billboard.disableDepthTestDistance = 0;
        });

        viewer.dataSources.add(platformClusterSource);

        // Create clustered data source for IXPs
        const ixpClusterSource = new Cesium.CustomDataSource('ixps-clustered');
        ixpClusterSource.clustering.enabled = true;
        ixpClusterSource.clustering.pixelRange = 40;
        ixpClusterSource.clustering.minimumClusterSize = 2;
        ixpClusterSource.clustering.clusterBillboards = true;
        ixpClusterSource.clustering.clusterLabels = true;

        ixpClusterSource.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
            cluster.billboard.show = true;
            cluster.label.show = true;
            cluster.label.text = clusteredEntities.length.toString();
            cluster.label.font = '600 12px JetBrains Mono';
            cluster.label.fillColor = Cesium.Color.WHITE;
            cluster.label.outlineColor = Cesium.Color.MAGENTA;
            cluster.label.outlineWidth = 2;
            cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
            cluster.label.disableDepthTestDistance = 0;

            const count = clusteredEntities.length;
            const size = count > 20 ? 36 : count > 10 ? 30 : 24;

            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            ctx.beginPath();
            ctx.arc(size/2, size/2, size/2 - 2, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(200, 0, 255, 0.8)';
            ctx.fill();
            ctx.strokeStyle = '#ff00ff';
            ctx.lineWidth = 2;
            ctx.stroke();

            cluster.billboard.image = canvas.toDataURL();
            cluster.billboard.width = size;
            cluster.billboard.height = size;
            cluster.billboard.disableDepthTestDistance = 0;
        });

        viewer.dataSources.add(ixpClusterSource);

        // Clustered data source for flight billboards — dense regions collapse into
        // a count bubble instead of overlapping aircraft markers. Routes stay in
        // viewer.entities (polylines don't cluster).
        const flightClusterSource = new Cesium.CustomDataSource('flights-clustered');
        flightClusterSource.clustering.enabled = true;
        flightClusterSource.clustering.pixelRange = 36;
        flightClusterSource.clustering.minimumClusterSize = 4;
        flightClusterSource.clustering.clusterBillboards = true;
        flightClusterSource.clustering.clusterLabels = true;
        flightClusterSource.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
            const count = clusteredEntities.length;
            const size = count > 50 ? 40 : count > 20 ? 34 : count > 10 ? 28 : 24;
            const canvas = document.createElement('canvas');
            canvas.width = size; canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2 - 2, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(0, 200, 255, 0.78)';   // aviation cyan
            ctx.fill();
            ctx.strokeStyle = '#00e5ff';
            ctx.lineWidth = 2;
            ctx.stroke();
            cluster.billboard.show = true;
            cluster.billboard.image = canvas.toDataURL();
            cluster.billboard.width = size;
            cluster.billboard.height = size;
            cluster.billboard.disableDepthTestDistance = 0;
            cluster.label.show = true;
            cluster.label.text = count.toString();
            cluster.label.font = '600 13px JetBrains Mono';
            cluster.label.fillColor = Cesium.Color.WHITE;
            cluster.label.outlineColor = Cesium.Color.fromCssColorString('#003844');
            cluster.label.outlineWidth = 2;
            cluster.label.style = Cesium.LabelStyle.FILL_AND_OUTLINE;
            cluster.label.pixelOffset = new Cesium.Cartesian2(0, 0);
            cluster.label.disableDepthTestDistance = 0;
        });
        viewer.dataSources.add(flightClusterSource);

        console.log('[CLUSTER] Platform, IXP and flight clustering enabled');

        // ============================================
        // PERFORMANCE UTILITIES
        // ============================================

        // Batch entity operations with requestAnimationFrame
        const entityBatcher = {
            pending: [],
            scheduled: false,
            maxBatchSize: 50, // Process max 50 entities per frame

            add(operation) {
                this.pending.push(operation);
                if (!this.scheduled) {
                    this.scheduled = true;
                    requestAnimationFrame(() => this.flush());
                }
            },

            flush() {
                const batch = this.pending.splice(0, this.maxBatchSize);
                batch.forEach(op => {
                    try { op(); } catch(e) { console.error('[BATCH] Entity op error:', e); }
                });
                // If more pending, schedule another frame
                if (this.pending.length > 0) {
                    requestAnimationFrame(() => this.flush());
                } else {
                    this.scheduled = false;
                }
            }
        };

        // Throttle function for expensive operations
        function throttle(fn, wait) {
            let lastCall = 0;
            let timeout = null;
            return function(...args) {
                const now = Date.now();
                const remaining = wait - (now - lastCall);
                if (remaining <= 0) {
                    lastCall = now;
                    fn.apply(this, args);
                } else if (!timeout) {
                    timeout = setTimeout(() => {
                        lastCall = Date.now();
                        timeout = null;
                        fn.apply(this, args);
                    }, remaining);
                }
            };
        }

        // ============================================
        // PERFORMANCE INFRASTRUCTURE
        // ============================================

        // Shared Cesium objects (avoid creating new instances)
        const cesiumShared = {
            // Pre-created scale properties for reuse
            scales: {
                flight: new Cesium.NearFarScalar(1e5, 1.8, 5e6, 0.5),
                vessel: new Cesium.NearFarScalar(1e5, 1.5, 5e6, 0.3),
                platform: new Cesium.NearFarScalar(1e5, 1.2, 5e6, 0.2),
                label: new Cesium.NearFarScalar(1e5, 1, 3e6, 0),
                base: new Cesium.NearFarScalar(1e5, 1.2, 1e7, 0.3)
            },
            // Distance conditions
            distances: {
                near: new Cesium.DistanceDisplayCondition(0, 3e6),
                medium: new Cesium.DistanceDisplayCondition(0, 5e6),
                far: new Cesium.DistanceDisplayCondition(0, 8e6)
            },
            // Common offsets
            offsets: {
                labelAbove: new Cesium.Cartesian2(0, -20),
                labelBelow: new Cesium.Cartesian2(0, 20),
                center: new Cesium.Cartesian2(0, 0)
            },
            // Pre-created colors
            colors: {
                flight: Cesium.Color.fromCssColorString('#00ff88'),
                vessel: Cesium.Color.fromCssColorString('#00ddff'),
                platform: Cesium.Color.fromCssColorString('#ff6600'),
                cable: Cesium.Color.fromCssColorString('#00ff88'),
                ixp: Cesium.Color.fromCssColorString('#ff00ff')
            },
            // Depth test settings: 0 = respect occlusion (hide behind globe)
            // Use Number.POSITIVE_INFINITY for space objects (Sun/Moon)
            depthTest: {
                surface: 0,  // Earth surface objects - hide behind globe
                space: Number.POSITIVE_INFINITY  // Space objects - always visible
            }
        };

        // Layer settings (user-configurable detail levels)
        const layerSettings = {
            flights: { enabled: true, detail: 'high', maxEntities: 200, showLabels: true, showRoutes: true },
            vessels: { enabled: true, detail: 'medium', maxEntities: 100, showLabels: true },
            platforms: { enabled: true, detail: 'medium', maxEntities: 100, showLabels: false },
            cables: { enabled: true, detail: 'low', maxEntities: 50, showLabels: false },
            ixps: { enabled: true, detail: 'high', maxEntities: 100, showLabels: true },
            seismic: { enabled: true, detail: 'medium', maxEntities: 50, showLabels: true },
            bases: { enabled: true, detail: 'high', maxEntities: 100, showLabels: true }
        };

        // Detail level multipliers
        const detailMultipliers = {
            low: 0.25,
            medium: 0.5,
            high: 1.0,
            ultra: 1.5
        };

        // Get effective max entities for a layer
        function getEffectiveLimit(layerName) {
            const settings = layerSettings[layerName];
            if (!settings || !settings.enabled) return 0;
            return Math.round(settings.maxEntities * detailMultipliers[settings.detail]);
        }

        // Performance metrics with real monitoring
        const perfMetrics = {
            entityUpdates: 0,
            lastFrameTime: 0,
            avgFrameTime: 16,
            frameCount: 0,
            entityCount: 0,
            memoryUsage: 0,
            layerStats: {},

            update() {
                // Count the default collection AND all clustered DataSources
                // (flights/platforms/IXPs live in their own sources now)
                let total = viewer.entities.values.length;
                for (let i = 0; i < viewer.dataSources.length; i++) {
                    total += viewer.dataSources.get(i).entities.values.length;
                }
                this.entityCount = total;
                this.frameCount++;

                // Update layer stats
                this.layerStats = {
                    flights: flightEntities.size,
                    vessels: aisVesselEntities.size,
                    platforms: platformEntities.size,
                    cables: cableEntities.length,
                    seismic: earthquakeEntities.size
                };

                // Track memory if available
                if (performance.memory) {
                    this.memoryUsage = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
                }
            },

            reset() {
                this.entityUpdates = 0;
            },

            getReport() {
                return {
                    entities: this.entityCount,
                    fps: Math.round(1000 / this.avgFrameTime),
                    memory: this.memoryUsage + 'MB',
                    layers: this.layerStats
                };
            }
        };

        // Performance monitoring interval
        setInterval(() => {
            perfMetrics.update();
            // Log if performance degrades
            if (perfMetrics.entityCount > 1000) {
                console.warn(`[PERF] High entity count: ${perfMetrics.entityCount}`);
            }
        }, 5000);

        // LOD (Level of Detail) System for performance
        const maritimeLOD = {
            // Raw data storage (not displayed)
            data: {
                platforms: [],
                cables: [],
                landingPoints: [],
                vessels: []
            },
            // Current display limits based on zoom - increased for better coverage
            limits: {
                global: { platforms: 50, cables: 100, vessels: 80 },      // Very zoomed out - show all major cables
                continent: { platforms: 150, cables: 200, vessels: 150 }, // Continental view
                region: { platforms: 400, cables: 400, vessels: 300 },    // Regional view
                local: { platforms: 700, cables: 500, vessels: 500 }      // Zoomed in - full detail
            },
            // Current zoom level
            currentLevel: 'global',
            // Last camera position for change detection
            lastCameraHeight: null,
            // Displayed entity counts
            displayed: { platforms: 0, cables: 0, vessels: 0 }
        };

        // Determine LOD level based on camera height
        function getLODLevel(cameraHeight) {
            if (cameraHeight > 10000000) return 'global';      // > 10,000 km
            if (cameraHeight > 3000000) return 'continent';    // > 3,000 km
            if (cameraHeight > 500000) return 'region';        // > 500 km
            return 'local';                                     // < 500 km
        }

        // Get current camera bounds (visible area)
        function getCameraBounds() {
            const canvas = viewer.scene.canvas;
            const corners = [
                new Cesium.Cartesian2(0, 0),
                new Cesium.Cartesian2(canvas.width, 0),
                new Cesium.Cartesian2(0, canvas.height),
                new Cesium.Cartesian2(canvas.width, canvas.height)
            ];

            let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
            let validCorners = 0;

            corners.forEach(corner => {
                const cartesian = viewer.camera.pickEllipsoid(corner, viewer.scene.globe.ellipsoid);
                if (cartesian) {
                    const carto = Cesium.Cartographic.fromCartesian(cartesian);
                    const lon = Cesium.Math.toDegrees(carto.longitude);
                    const lat = Cesium.Math.toDegrees(carto.latitude);
                    minLon = Math.min(minLon, lon);
                    maxLon = Math.max(maxLon, lon);
                    minLat = Math.min(minLat, lat);
                    maxLat = Math.max(maxLat, lat);
                    validCorners++;
                }
            });

            // If we can't determine bounds, return global
            if (validCorners < 2) {
                return { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 };
            }

            // Add padding
            const lonPad = (maxLon - minLon) * 0.1;
            const latPad = (maxLat - minLat) * 0.1;

            return {
                minLon: minLon - lonPad,
                maxLon: maxLon + lonPad,
                minLat: minLat - latPad,
                maxLat: maxLat + latPad
            };
        }

        // Check if a point is within bounds
        function isInBounds(lon, lat, bounds) {
            return lon >= bounds.minLon && lon <= bounds.maxLon &&
                   lat >= bounds.minLat && lat <= bounds.maxLat;
        }

        // Filter and prioritize data for display
        function filterForDisplay(items, bounds, limit, priorityFn) {
            // First filter by bounds
            let filtered = items.filter(item => {
                const lon = item.longitude || item.geometry?.coordinates?.[0];
                const lat = item.latitude || item.geometry?.coordinates?.[1];
                if (lon === undefined || lat === undefined) return false;
                return isInBounds(lon, lat, bounds);
            });

            // Sort by priority (if provided)
            if (priorityFn) {
                filtered.sort((a, b) => priorityFn(b) - priorityFn(a));
            }

            // Limit results
            return filtered.slice(0, limit);
        }

        // Update maritime display based on LOD
        function updateMaritimeLOD() {
            const cameraHeight = viewer.camera.positionCartographic.height;
            const newLevel = getLODLevel(cameraHeight);
            const bounds = getCameraBounds();
            const limits = maritimeLOD.limits[newLevel];

            // Only update if level changed significantly or camera moved
            const heightChanged = Math.abs(cameraHeight - (maritimeLOD.lastCameraHeight || 0)) > 100000;
            const levelChanged = newLevel !== maritimeLOD.currentLevel;

            if (!levelChanged && !heightChanged) return;

            maritimeLOD.currentLevel = newLevel;
            maritimeLOD.lastCameraHeight = cameraHeight;

            console.log(`[LOD] Level: ${newLevel}, Height: ${(cameraHeight/1000).toFixed(0)}km, Limits: P=${limits.platforms} C=${limits.cables} V=${limits.vessels}`);

            // Update platforms
            if (maritimeLayersVisible.platforms && maritimeLOD.data.platforms.length > 0) {
                updatePlatformsLOD(bounds, limits.platforms);
            }

            // Update cables
            if (maritimeLayersVisible.cables && maritimeLOD.data.cables.length > 0) {
                updateCablesLOD(bounds, limits.cables);
            }

            // Update vessels
            if (maritimeLayersVisible.aisVessels && maritimeLOD.data.vessels.length > 0) {
                updateVesselsLOD(bounds, limits.vessels);
            }

            updateMaritimeCount();
        }

        // Update platforms with LOD (batched for performance)
        function updatePlatformsLOD(bounds, limit) {
            // Batch remove existing entities from cluster source
            const toRemove = Array.from(platformEntities.values());
            toRemove.forEach(e => entityBatcher.add(() => platformClusterSource.entities.remove(e)));
            platformEntities.clear();

            // Priority: FPSO > Gas > Oil, and by region importance
            const priorityFn = (p) => {
                let score = 0;
                if (p.type?.includes('FPSO')) score += 10;
                if (p.type?.includes('Gas')) score += 5;
                if (p.region?.includes('Gulf')) score += 3;
                if (p.region?.includes('North Sea')) score += 3;
                return score;
            };

            const toShow = filterForDisplay(maritimeLOD.data.platforms, bounds, limit, priorityFn);
            // Batch add new entities
            toShow.forEach(platform => entityBatcher.add(() => addPlatform(platform)));
            maritimeLOD.displayed.platforms = toShow.length;
        }

        // Track which cables are currently displayed (by cable ID)
        const displayedCableIds = new Set();

        // Update cables with LOD (incremental - preserves existing cables)
        function updateCablesLOD(bounds, limit) {
            // Priority: longer cables, active over planned, major routes
            const priorityFn = (c) => {
                let score = 0;
                if (!c.properties?.is_planned) score += 10;
                if (c.properties?.length_km > 5000) score += 5;
                if (c.properties?.length_km > 10000) score += 5;
                // Major cables get priority
                const name = (c.properties?.name || '').toLowerCase();
                if (name.includes('sea-me-we') || name.includes('marea') || name.includes('grace')) score += 8;
                if (name.includes('atlantic') || name.includes('pacific') || name.includes('asia')) score += 4;
                return score;
            };

            // Filter cables that pass through or near bounds
            const filteredCables = maritimeLOD.data.cables.filter(cable => {
                const coords = cable.geometry?.coordinates;
                if (!coords) return false;
                // Check if any point of the cable is in bounds
                const isMulti = cable.geometry.type === 'MultiLineString';
                const segments = isMulti ? coords : [coords];
                return segments.some(seg =>
                    seg.some(coord => isInBounds(coord[0], coord[1], bounds))
                );
            });

            filteredCables.sort((a, b) => priorityFn(b) - priorityFn(a));
            const targetCables = filteredCables.slice(0, limit);
            const targetIds = new Set(targetCables.map(c => c.properties?.id || c.properties?.name));

            // Only add cables that aren't already displayed
            const toAdd = targetCables.filter(cable => {
                const id = cable.properties?.id || cable.properties?.name;
                return !displayedCableIds.has(id);
            });

            // Add new cables
            toAdd.forEach(cable => {
                const id = cable.properties?.id || cable.properties?.name;
                displayedCableIds.add(id);
                entityBatcher.add(() => addSubmarineCable(cable));
            });

            maritimeLOD.displayed.cables = cableEntities.length;
        }

        // Update vessels with LOD (batched + entity reuse)
        function updateVesselsLOD(bounds, limit) {
            // Priority: military > large cargo > tankers > other
            const priorityFn = (v) => {
                let score = 0;
                const type = v.shipTypeName || '';
                if (type.includes('Military')) score += 20;
                if (type.includes('Law Enforcement')) score += 15;
                if (type.includes('Tanker')) score += 10;
                if (type.includes('Cargo')) score += 8;
                if (type.includes('Passenger')) score += 5;
                if (v.speed > 15) score += 3; // Fast moving
                if (v.dimensions?.length > 200) score += 5; // Large
                return score;
            };

            const toShow = filterForDisplay(maritimeLOD.data.vessels, bounds, limit, priorityFn);
            const toShowIds = new Set(toShow.map(v => v.mmsi));

            // Remove vessels no longer in view
            for (const [mmsi, entity] of aisVesselEntities) {
                if (!toShowIds.has(mmsi)) {
                    entityBatcher.add(() => viewer.entities.remove(entity));
                    aisVesselEntities.delete(mmsi);
                }
            }

            // Add or update vessels (reuse existing entities when possible)
            toShow.forEach(vessel => {
                const existing = aisVesselEntities.get(vessel.mmsi);
                if (existing) {
                    // Update existing entity position and rotation (cheaper than remove/add)
                    entityBatcher.add(() => {
                        existing.position = Cesium.Cartesian3.fromDegrees(vessel.longitude, vessel.latitude);
                        if (existing.billboard) {
                            const headingRad = Cesium.Math.toRadians(vessel.heading || vessel.course || 0);
                            existing.billboard.rotation = -headingRad;
                        }
                    });
                } else {
                    entityBatcher.add(() => addAISVessel(vessel));
                }
            });

            maritimeLOD.displayed.vessels = toShow.length;
        }

        // Flight route tracking - max positions to keep per flight
        const MAX_ROUTE_POSITIONS = 50;
        
        // US Military Bases worldwide (major ones)
        const US_MILITARY_BASES = [
            // Middle East
            { name: 'Al Udeid AB', lat: 25.117, lon: 51.315, type: 'airbase', region: 'CENTCOM' },
            { name: 'Al Dhafra AB', lat: 24.248, lon: 54.547, type: 'airbase', region: 'CENTCOM' },
            { name: 'Camp Arifjan', lat: 28.933, lon: 48.183, type: 'army', region: 'CENTCOM' },
            { name: 'Bahrain NSA', lat: 26.236, lon: 50.652, type: 'navy', region: 'CENTCOM' },
            { name: 'Diego Garcia', lat: -7.316, lon: 72.411, type: 'airbase', region: 'INDOPACOM' },
            
            // Europe
            { name: 'Ramstein AB', lat: 49.437, lon: 7.600, type: 'airbase', region: 'EUCOM' },
            { name: 'RAF Lakenheath', lat: 52.409, lon: 0.561, type: 'airbase', region: 'EUCOM' },
            { name: 'RAF Fairford', lat: 51.682, lon: -1.790, type: 'airbase', region: 'EUCOM' },
            { name: 'Aviano AB', lat: 46.032, lon: 12.597, type: 'airbase', region: 'EUCOM' },
            { name: 'Incirlik AB', lat: 37.002, lon: 35.426, type: 'airbase', region: 'EUCOM' },
            { name: 'Rota NS', lat: 36.642, lon: -6.350, type: 'navy', region: 'EUCOM' },
            { name: 'Naples NSA', lat: 40.817, lon: 14.200, type: 'navy', region: 'EUCOM' },
            { name: 'Grafenwöhr', lat: 49.697, lon: 11.940, type: 'army', region: 'EUCOM' },
            { name: 'Spangdahlem AB', lat: 49.972, lon: 6.693, type: 'airbase', region: 'EUCOM' },
            
            // Pacific / Asia
            { name: 'Kadena AB', lat: 26.352, lon: 127.769, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Yokota AB', lat: 35.748, lon: 139.349, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Misawa AB', lat: 40.703, lon: 141.368, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Osan AB', lat: 37.090, lon: 127.030, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Kunsan AB', lat: 35.922, lon: 126.616, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Andersen AFB', lat: 13.584, lon: 144.930, type: 'airbase', region: 'INDOPACOM' },
            { name: 'Yokosuka NB', lat: 35.292, lon: 139.665, type: 'navy', region: 'INDOPACOM' },
            { name: 'Camp Humphreys', lat: 36.963, lon: 127.013, type: 'army', region: 'INDOPACOM' },
            
            // Americas
            { name: 'Guantanamo Bay', lat: 19.905, lon: -75.097, type: 'navy', region: 'SOUTHCOM' },
            { name: 'Soto Cano AB', lat: 14.382, lon: -87.621, type: 'airbase', region: 'SOUTHCOM' },
            
            // Atlantic
            { name: 'Thule AB', lat: 76.531, lon: -68.703, type: 'airbase', region: 'NORTHCOM' },
            { name: 'Keflavik', lat: 63.985, lon: -22.606, type: 'airbase', region: 'EUCOM' },
            { name: 'Lajes Field', lat: 38.762, lon: -27.091, type: 'airbase', region: 'EUCOM' },
            
            // Africa
            { name: 'Camp Lemonnier', lat: 11.547, lon: 43.159, type: 'navy', region: 'AFRICOM' },
            
            // Carrier Strike Groups (approximate positions - would need live tracking)
            { name: 'CVN - Atlantic', lat: 35.0, lon: -40.0, type: 'carrier', region: 'FLEET' },
            { name: 'CVN - Mediterranean', lat: 35.5, lon: 18.0, type: 'carrier', region: 'FLEET' },
            { name: 'CVN - Pacific', lat: 20.0, lon: 140.0, type: 'carrier', region: 'FLEET' },
            { name: 'CVN - Persian Gulf', lat: 26.0, lon: 52.0, type: 'carrier', region: 'FLEET' },
        ];
        
        // Create military base symbol
        // Memoization for generated symbol images — avoids redundant canvas redraws
        // (createAircraftSymbol alone is called ~300x per flight update).
        const _symbolCache = new Map();
        function _memoSymbol(fn, prefix, keyArgs) {
            return function (...args) {
                const key = prefix + '|' + keyArgs(...args);
                const hit = _symbolCache.get(key);
                if (hit !== undefined) return hit;
                const val = fn.apply(this, args);
                _symbolCache.set(key, val);
                return val;
            };
        }

        function createBaseSymbol(baseType, color) {
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d');
            const cx = 16, cy = 16;

            ctx.shadowColor = color;
            ctx.shadowBlur = 6;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.fillStyle = color;

            switch(baseType) {
                case 'carrier':
                    // Aircraft carrier symbol - ship shape with deck
                    ctx.beginPath();
                    ctx.moveTo(16, 4);   // bow
                    ctx.lineTo(24, 10);
                    ctx.lineTo(26, 24);
                    ctx.lineTo(22, 28);  // stern
                    ctx.lineTo(10, 28);
                    ctx.lineTo(6, 24);
                    ctx.lineTo(8, 10);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    // Flight deck line
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(10, 16);
                    ctx.lineTo(22, 16);
                    ctx.stroke();
                    // Island
                    ctx.fillStyle = '#fff';
                    ctx.fillRect(20, 12, 4, 6);
                    break;

                case 'airbase':
                    // Airbase symbol - runway with aircraft
                    ctx.beginPath();
                    ctx.moveTo(8, 8);
                    ctx.lineTo(24, 8);
                    ctx.lineTo(24, 24);
                    ctx.lineTo(8, 24);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    // Runway
                    ctx.fillStyle = '#333';
                    ctx.fillRect(10, 14, 12, 4);
                    // Centerline
                    ctx.strokeStyle = '#fff';
                    ctx.setLineDash([2, 2]);
                    ctx.beginPath();
                    ctx.moveTo(10, 16);
                    ctx.lineTo(22, 16);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    break;

                case 'navy':
                    // Navy base - anchor symbol
                    ctx.beginPath();
                    ctx.arc(16, 10, 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(16, 14);
                    ctx.lineTo(16, 26);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(10, 22);
                    ctx.lineTo(16, 26);
                    ctx.lineTo(22, 22);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(8, 26);
                    ctx.quadraticCurveTo(16, 30, 24, 26);
                    ctx.stroke();
                    break;

                case 'army':
                default:
                    // Army base - star in pentagon
                    const points = 5;
                    const outerR = 12;
                    const innerR = 5;
                    ctx.beginPath();
                    for (let i = 0; i < points * 2; i++) {
                        const r = i % 2 === 0 ? outerR : innerR;
                        const angle = (i * Math.PI / points) - Math.PI / 2;
                        const x = cx + r * Math.cos(angle);
                        const y = cy + r * Math.sin(angle);
                        if (i === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);
                    }
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
            }

            return canvas.toDataURL();
        }

        // Add US bases to globe
        function addMilitaryBases() {
            US_MILITARY_BASES.forEach(base => {
                const colorHex = base.type === 'carrier' ? '#ff0040' :
                                base.type === 'airbase' ? '#00ffff' :
                                base.type === 'navy' ? '#4080ff' : '#00ff00';

                const color = base.type === 'carrier' ? Cesium.Color.fromCssColorString('#ff0040') :
                             base.type === 'airbase' ? Cesium.Color.CYAN :
                             base.type === 'navy' ? Cesium.Color.fromCssColorString('#4080ff') :
                             Cesium.Color.GREEN;

                const baseImage = createBaseSymbol(base.type, colorHex);

                const entity = viewer.entities.add({
                    name: base.name,
                    position: Cesium.Cartesian3.fromDegrees(base.lon, base.lat),
                    billboard: {
                        image: baseImage,
                        width: 28,
                        height: 28,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 1e7, 0.4),
                        disableDepthTestDistance: 0
                    },
                    label: {
                        text: base.name,
                        font: '10px JetBrains Mono',
                        fillColor: color,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        pixelOffset: new Cesium.Cartesian2(0, -20),
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 3e6, 0),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5e6),
                        disableDepthTestDistance: 0
                    }
                });

                // Add custom data for hover
                entity.customData = {
                    type: 'base',
                    name: base.name,
                    baseType: base.type,
                    region: base.region,
                    lat: base.lat,
                    lon: base.lon
                };

                baseEntities.set(base.name, entity);
            });

            console.log('Added', US_MILITARY_BASES.length, 'military bases to globe');
        }
        
        // Call on init - AFTER all functions are defined
        addMilitaryBases();
        
        // ============================================
        // CONFLICT ZONES & REGIONS OF INTEREST
        // ============================================

        const zoneEntities = [];

        // Country/region configurations with threat levels
        const REGION_CONFIG = {
            'Ukraine': { type: 'WAR_ZONE', status: 'ACTIVE CONFLICT', color: 'rgba(255, 40, 40, 0.35)', borderColor: '#ff3333', height: 50000 },
            'Russia': { type: 'ADVERSARY', status: 'HOSTILE', color: 'rgba(200, 0, 0, 0.15)', borderColor: '#cc0000', height: 20000 },
            'Syria': { type: 'WAR_ZONE', status: 'CONFLICT ZONE', color: 'rgba(255, 80, 0, 0.35)', borderColor: '#ff6600', height: 40000 },
            'Yemen': { type: 'WAR_ZONE', status: 'HOUTHI CONFLICT', color: 'rgba(255, 80, 0, 0.35)', borderColor: '#ff6600', height: 40000 },
            'Iran': { type: 'WATCH_ZONE', status: 'TARGET WATCH', color: 'rgba(255, 140, 0, 0.25)', borderColor: '#ff8800', height: 30000 },
            'North Korea': { type: 'PROHIBITED', status: 'NO FLY ZONE', color: 'rgba(180, 0, 180, 0.4)', borderColor: '#cc00cc', height: 60000 },
            'Taiwan': { type: 'TENSION_ZONE', status: 'CHINA THREAT', color: 'rgba(255, 220, 0, 0.3)', borderColor: '#ffdd00', height: 25000 },
            'Venezuela': { type: 'WATCH_ZONE', status: 'US WATCH', color: 'rgba(255, 200, 0, 0.2)', borderColor: '#ffcc00', height: 20000 },
            'Greenland': { type: 'STRATEGIC', status: 'NATO INTEREST', color: 'rgba(0, 150, 255, 0.2)', borderColor: '#0099ff', height: 15000 },
            'Lebanon': { type: 'TENSION_ZONE', status: 'HIGH TENSION', color: 'rgba(255, 165, 0, 0.35)', borderColor: '#ffaa00', height: 30000 },
            'Israel': { type: 'COMBAT_ZONE', status: 'ACTIVE OPS', color: 'rgba(255, 100, 0, 0.3)', borderColor: '#ff6600', height: 35000 },
            'Cuba': { type: 'WATCH_ZONE', status: 'MONITORING', color: 'rgba(255, 200, 0, 0.15)', borderColor: '#ffcc00', height: 15000 },
            'China': { type: 'ADVERSARY', status: 'STRATEGIC RIVAL', color: 'rgba(200, 50, 50, 0.12)', borderColor: '#cc3333', height: 15000 },
            'Belarus': { type: 'ADVERSARY', status: 'RU ALLY', color: 'rgba(200, 0, 0, 0.2)', borderColor: '#cc0000', height: 20000 }
        };

        // Special zones (straits, seas, etc.) - still use coordinates
        const SPECIAL_ZONES = [
            {
                name: 'GAZA STRIP',
                type: 'COMBAT_ZONE',
                status: 'ACTIVE COMBAT',
                color: 'rgba(255, 0, 0, 0.6)',
                borderColor: '#ff0000',
                height: 80000,
                coordinates: [[34.22, 31.59], [34.56, 31.59], [34.49, 31.22], [34.27, 31.22], [34.22, 31.59]]
            },
            {
                name: 'STRAIT OF HORMUZ',
                type: 'STRATEGIC',
                status: 'CHOKEPOINT',
                color: 'rgba(0, 200, 255, 0.35)',
                borderColor: '#00ccff',
                height: 15000,
                coordinates: [[54.0, 27.2], [57.0, 27.2], [57.0, 25.2], [54.0, 25.2], [54.0, 27.2]]
            },
            {
                name: 'BAB EL-MANDEB',
                type: 'DANGER_ZONE',
                status: 'HOUTHI THREAT',
                color: 'rgba(255, 50, 50, 0.4)',
                borderColor: '#ff4444',
                height: 40000,
                coordinates: [[42.5, 13.5], [44.0, 13.5], [44.0, 11.5], [42.5, 11.5], [42.5, 13.5]]
            },
            {
                name: 'TAIWAN STRAIT',
                type: 'TENSION_ZONE',
                status: 'PLA ACTIVITY',
                color: 'rgba(255, 220, 0, 0.3)',
                borderColor: '#ffdd00',
                height: 25000,
                coordinates: [[117.5, 25.5], [120.5, 25.5], [120.5, 23.0], [117.5, 23.0], [117.5, 25.5]]
            },
            {
                name: 'BLACK SEA',
                type: 'RESTRICTED',
                status: 'WAR ZONE',
                color: 'rgba(255, 80, 0, 0.25)',
                borderColor: '#ff5500',
                height: 20000,
                coordinates: [[28.0, 46.5], [41.5, 46.5], [41.5, 41.0], [28.0, 41.0], [28.0, 46.5]]
            },
            {
                name: 'KALININGRAD',
                type: 'GPS_INTERFERENCE',
                status: 'RU JAMMING',
                color: 'rgba(255, 0, 255, 0.4)',
                borderColor: '#ff00ff',
                height: 50000,
                coordinates: [[19.3, 55.3], [22.9, 55.3], [22.9, 54.3], [19.3, 54.3], [19.3, 55.3]]
            },
            {
                name: 'BALTIC GPS JAM',
                type: 'GPS_INTERFERENCE',
                status: 'JAMMING ACTIVE',
                color: 'rgba(255, 0, 255, 0.2)',
                borderColor: '#ff00ff',
                height: 30000,
                coordinates: [[14.0, 59.5], [28.0, 59.5], [28.0, 54.5], [14.0, 54.5], [14.0, 59.5]]
            },
            {
                name: 'SOUTH CHINA SEA',
                type: 'TENSION_ZONE',
                status: 'DISPUTED',
                color: 'rgba(255, 200, 0, 0.15)',
                borderColor: '#ffcc00',
                height: 15000,
                coordinates: [[105.0, 23.0], [121.0, 23.0], [121.0, 5.0], [105.0, 5.0], [105.0, 23.0]]
            },
            {
                name: 'DONBAS FRONT',
                type: 'COMBAT_ZONE',
                status: 'HEAVY FIGHTING',
                color: 'rgba(255, 0, 0, 0.5)',
                borderColor: '#ff0000',
                height: 70000,
                coordinates: [[36.5, 49.5], [40.0, 49.5], [40.0, 47.0], [36.5, 47.0], [36.5, 49.5]]
            }
        ];

        // Load country boundaries from GeoJSON
        async function loadCountryBoundaries() {
            try {
                // Use Natural Earth low-res countries GeoJSON
                const response = await fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson');
                const geojson = await response.json();

                console.log('[ZONES] Loaded', geojson.features.length, 'country boundaries');

                // Filter and style countries of interest
                geojson.features.forEach(feature => {
                    const countryName = feature.properties.ADMIN || feature.properties.name;
                    const config = REGION_CONFIG[countryName];

                    if (config) {
                        addCountryZone(feature, countryName, config);
                    }
                });

                // Add special zones (straits, combat areas, etc.)
                addSpecialZones();

                console.log('[ZONES] Added', Object.keys(REGION_CONFIG).length, 'country zones +', SPECIAL_ZONES.length, 'special zones');

            } catch (error) {
                console.error('[ZONES] Error loading GeoJSON:', error);
                // Fallback to special zones only
                addSpecialZones();
            }
        }

        function addCountryZone(feature, name, config) {
            const color = Cesium.Color.fromCssColorString(config.color);
            const borderColor = Cesium.Color.fromCssColorString(config.borderColor);

            // Handle both Polygon and MultiPolygon
            const geometryType = feature.geometry.type;
            const coordinates = feature.geometry.coordinates;

            if (geometryType === 'Polygon') {
                addPolygonZone(coordinates[0], name, config, color, borderColor);
            } else if (geometryType === 'MultiPolygon') {
                // Add each polygon part
                coordinates.forEach((polygon, idx) => {
                    addPolygonZone(polygon[0], name + (idx > 0 ? ` (${idx + 1})` : ''), config, color, borderColor, idx === 0);
                });
            }
        }

        function addPolygonZone(coords, name, config, color, borderColor, addLabel = true) {
            // Convert GeoJSON coords [lon, lat] to flat array for Cesium
            const positions = [];
            coords.forEach(coord => {
                positions.push(coord[0], coord[1]);
            });

            // Create filled polygon with height
            const entity = viewer.entities.add({
                name: name,
                polygon: {
                    hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                    material: color,
                    outline: false,
                    height: 0,
                    extrudedHeight: config.height,
                    closeTop: true,
                    closeBottom: true
                }
            });

            // Add glowing border
            viewer.entities.add({
                name: name + '_border',
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArray(positions),
                    width: 2.5,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.4,
                        color: borderColor
                    }),
                    clampToGround: true
                }
            });

            // Add custom data for hover
            entity.customData = {
                type: 'zone',
                name: name,
                zoneType: config.type,
                status: config.status
            };

            zoneEntities.push(entity);

            // Add label at centroid (only for first polygon of multi)
            if (addLabel) {
                const centroid = calculateCentroid(coords);
                viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, config.height + 10000),
                    label: {
                        text: '⚠ ' + name.toUpperCase(),
                        font: '600 11px JetBrains Mono',
                        fillColor: borderColor,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 1e7, 0.3),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 8e6)
                    }
                });

                // Status label
                viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, config.height + 5000),
                    label: {
                        text: '[' + config.status + ']',
                        font: '10px JetBrains Mono',
                        fillColor: config.type.includes('COMBAT') || config.type.includes('WAR') ?
                            Cesium.Color.RED : Cesium.Color.ORANGE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.TOP,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 6e6, 0.2),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5e6)
                    }
                });
            }
        }

        function calculateCentroid(coords) {
            let sumLon = 0, sumLat = 0;
            coords.forEach(c => {
                sumLon += c[0];
                sumLat += c[1];
            });
            return { lon: sumLon / coords.length, lat: sumLat / coords.length };
        }

        function addSpecialZones() {
            SPECIAL_ZONES.forEach(zone => {
                const positions = [];
                zone.coordinates.forEach(coord => {
                    positions.push(coord[0], coord[1]);
                });

                const color = Cesium.Color.fromCssColorString(zone.color);
                const borderColor = Cesium.Color.fromCssColorString(zone.borderColor);

                // Create zone polygon
                const entity = viewer.entities.add({
                    name: zone.name,
                    polygon: {
                        hierarchy: Cesium.Cartesian3.fromDegreesArray(positions),
                        material: color,
                        outline: false,
                        height: 0,
                        extrudedHeight: zone.height,
                        closeTop: true,
                        closeBottom: true
                    }
                });

                // Glowing border
                viewer.entities.add({
                    name: zone.name + '_border',
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray(positions),
                        width: 3,
                        material: new Cesium.PolylineGlowMaterialProperty({
                            glowPower: 0.5,
                            color: borderColor
                        }),
                        clampToGround: true
                    }
                });

                entity.customData = {
                    type: 'zone',
                    name: zone.name,
                    zoneType: zone.type,
                    status: zone.status
                };

                zoneEntities.push(entity);

                // Label
                const centroid = calculateCentroid(zone.coordinates);
                viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, zone.height + 8000),
                    label: {
                        text: '⚠ ' + zone.name,
                        font: '500 11px JetBrains Mono',
                        fillColor: borderColor,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 6e6, 0.4),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5e6)
                    }
                });

                viewer.entities.add({
                    position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, zone.height + 3000),
                    label: {
                        text: '[' + zone.status + ']',
                        font: '9px JetBrains Mono',
                        fillColor: zone.type.includes('COMBAT') || zone.type.includes('WAR') || zone.type.includes('DANGER') ?
                            Cesium.Color.RED : Cesium.Color.ORANGE,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        verticalOrigin: Cesium.VerticalOrigin.TOP,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 4e6, 0.3),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4e6)
                    }
                });
            });
        }

        // Load country boundaries
        loadCountryBoundaries();
        
        // ============================================
        // HOVER & CLICK INTERACTION
        // ============================================
        
        const hoverInfo = document.getElementById('hover-info');
        const hoverTitle = document.getElementById('hover-title');
        const hoverContent = document.getElementById('hover-content');
        
        // Store entity data
        const entityData = new Map();
        
        // Mouse move handler for hover
        const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        
        handler.setInputAction(function(movement) {
            const pickedObject = viewer.scene.pick(movement.endPosition);
            
            if (Cesium.defined(pickedObject) && pickedObject.id) {
                const entity = pickedObject.id;
                const data = entity.customData || {};

                // Position info box near cursor
                hoverInfo.style.left = (movement.endPosition.x + 15) + 'px';
                hoverInfo.style.top = (movement.endPosition.y + 15) + 'px';

                // Build content based on entity type
                let title = '';
                let content = '';
                let typeClass = '';

                // Handle cluster hover (entity without customData but with label showing count)
                if (!data.type && entity.label && entity.label.text) {
                    const labelText = entity.label.text.getValue ? entity.label.text.getValue() : entity.label.text;
                    const count = parseInt(labelText);
                    if (!isNaN(count)) {
                        // Determine cluster type by checking parent datasource
                        let clusterType = 'items';
                        let clusterIcon = '📍';
                        let clusterColor = 'var(--accent)';

                        // Check which datasource this cluster belongs to
                        if (entity.entityCollection?.owner?.name === 'platforms-clustered') {
                            clusterType = 'platforms';
                            clusterIcon = '🛢️';
                            clusterColor = '#ffa000';
                        } else if (entity.entityCollection?.owner?.name === 'ixps-clustered') {
                            clusterType = 'IXPs';
                            clusterIcon = '🌐';
                            clusterColor = '#ff00ff';
                        }

                        title = `${clusterIcon} ${count} ${clusterType}`;
                        typeClass = 'base';
                        content = `
                            <div class="hover-info-row"><span class="hover-info-label">Items:</span><span class="hover-info-value" style="color: ${clusterColor}">${count}</span></div>
                            <div class="hover-info-row"><span class="hover-info-label">Type:</span><span class="hover-info-value">${clusterType.toUpperCase()}</span></div>
                            <div class="hover-info-type base" style="background: ${clusterColor}">CLUSTER</div>
                            <div style="font-size: 0.55rem; color: var(--text-dim); margin-top: 4px;">Zoom in to expand</div>
                        `;

                        hoverTitle.textContent = title;
                        hoverContent.innerHTML = content;
                        hoverInfo.classList.add('visible');
                        viewer.scene.canvas.style.cursor = 'pointer';
                        return;
                    }
                }
                
                if (data.type === 'flight') {
                    title = '✈️ ' + (data.callsign || data.icao24 || 'Unknown');
                    typeClass = 'flight';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">ICAO:</span><span class="hover-info-value">${data.icao24 || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Altitude:</span><span class="hover-info-value">${data.altitude ? Math.round(data.altitude) + ' ft' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Speed:</span><span class="hover-info-value">${data.velocity ? Math.round(data.velocity) + ' kts' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Heading:</span><span class="hover-info-value">${data.heading ? Math.round(data.heading) + '°' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Origin:</span><span class="hover-info-value">${data.origin || '--'}</span></div>
                        <div class="hover-info-type ${typeClass}">${data.category || 'AIRCRAFT'}</div>
                    `;
                } else if (data.type === 'earthquake') {
                    title = '🌍 Earthquake M' + data.magnitude?.toFixed(1);
                    typeClass = 'earthquake';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Location:</span><span class="hover-info-value">${data.place || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Magnitude:</span><span class="hover-info-value">${data.magnitude?.toFixed(1) || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Depth:</span><span class="hover-info-value">${data.depth ? data.depth.toFixed(1) + ' km' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Time:</span><span class="hover-info-value">${data.time ? new Date(data.time).toLocaleString() : '--'}</span></div>
                        <div class="hover-info-type ${typeClass}">SEISMIC EVENT</div>
                    `;
                } else if (data.type === 'base') {
                    title = '🎖️ ' + data.name;
                    typeClass = data.baseType === 'carrier' ? 'carrier' : 'base';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Type:</span><span class="hover-info-value">${data.baseType?.toUpperCase() || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Region:</span><span class="hover-info-value">${data.region || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Lat:</span><span class="hover-info-value">${data.lat?.toFixed(3) || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Lon:</span><span class="hover-info-value">${data.lon?.toFixed(3) || '--'}</span></div>
                        <div class="hover-info-type ${typeClass}">US MILITARY</div>
                    `;
                } else if (data.type === 'zone') {
                    title = '⚠️ ' + data.name;
                    const zoneColors = {
                        'WAR_ZONE': 'danger',
                        'COMBAT_ZONE': 'danger',
                        'PROHIBITED': 'danger',
                        'DANGER_ZONE': 'danger',
                        'TENSION_ZONE': 'warning',
                        'RESTRICTED': 'warning',
                        'GPS_INTERFERENCE': 'warning',
                        'WATCH_ZONE': 'warning',
                        'ADVERSARY': 'danger',
                        'ADIZ': 'base',
                        'STRATEGIC': 'flight'
                    };
                    typeClass = zoneColors[data.zoneType] || 'base';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Type:</span><span class="hover-info-value">${data.zoneType?.replace(/_/g, ' ') || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Status:</span><span class="hover-info-value" style="color: ${data.status?.includes('ACTIVE') || data.status?.includes('HEAVY') || data.status?.includes('HOSTILE') ? '#ff3355' : '#ffa000'}">${data.status || '--'}</span></div>
                        <div class="hover-info-type ${typeClass}">REGION</div>
                    `;
                } else if (data.type === 'weather') {
                    title = '🌡️ ' + data.name;
                    typeClass = 'flight';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Temp:</span><span class="hover-info-value">${data.temperature ? Math.round(data.temperature) + '°C' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Conditions:</span><span class="hover-info-value">${data.description || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Wind:</span><span class="hover-info-value">${data.wind ? Math.round(data.wind) + ' km/h' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Humidity:</span><span class="hover-info-value">${data.humidity ? data.humidity + '%' : '--'}</span></div>
                        <div class="hover-info-type flight">WEATHER STATION</div>
                    `;
                } else if (data.type === 'ixp') {
                    title = '🌐 ' + data.name;
                    typeClass = 'base';
                    const tierColors = { 1: '#ff00ff', 2: '#aa00ff', 3: '#6600ff' };
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">City:</span><span class="hover-info-value">${data.city || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Country:</span><span class="hover-info-value">${data.country || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Networks:</span><span class="hover-info-value" style="color: ${tierColors[data.tier] || '#6600ff'}">${data.networks || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Tier:</span><span class="hover-info-value">${data.tier || '--'}</span></div>
                        <div class="hover-info-type base" style="background: ${tierColors[data.tier] || '#6600ff'}">INTERNET EXCHANGE</div>
                        <div style="font-size: 0.55rem; color: var(--text-dim); margin-top: 4px;">Click for details & connections</div>
                    `;
                } else if (data.type === 'cable') {
                    title = '🔌 ' + data.name;
                    typeClass = 'flight';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Length:</span><span class="hover-info-value">${data.length_km ? data.length_km.toLocaleString() + ' km' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">RFS:</span><span class="hover-info-value">${data.rfs || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Status:</span><span class="hover-info-value">${data.is_planned ? 'Planned' : 'Active'}</span></div>
                        <div class="hover-info-type flight">SUBMARINE CABLE</div>
                    `;
                } else if (data.type === 'platform') {
                    title = '🛢️ ' + (data.name || 'Platform');
                    typeClass = 'earthquake';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Type:</span><span class="hover-info-value">${data.platformType || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Region:</span><span class="hover-info-value">${data.region || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Operator:</span><span class="hover-info-value">${data.operator || '--'}</span></div>
                        <div class="hover-info-type earthquake">OFFSHORE PLATFORM</div>
                    `;
                } else if (data.type === 'vessel') {
                    title = '🚢 ' + (data.name || data.mmsi);
                    typeClass = 'flight';
                    content = `
                        <div class="hover-info-row"><span class="hover-info-label">Type:</span><span class="hover-info-value">${data.shipTypeName || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Speed:</span><span class="hover-info-value">${data.speed ? data.speed.toFixed(1) + ' kts' : '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">Destination:</span><span class="hover-info-value">${data.destination || '--'}</span></div>
                        <div class="hover-info-row"><span class="hover-info-label">MMSI:</span><span class="hover-info-value">${data.mmsi || '--'}</span></div>
                        <div class="hover-info-type flight">AIS VESSEL</div>
                    `;
                } else {
                    // Generic entity
                    title = entity.name || 'Unknown';
                    content = '<div class="hover-info-row"><span class="hover-info-label">Position</span></div>';
                }
                
                hoverTitle.textContent = title;
                hoverContent.innerHTML = content;
                hoverInfo.classList.add('visible');
                
                // Change cursor
                viewer.scene.canvas.style.cursor = 'pointer';
            } else {
                hoverInfo.classList.remove('visible');
                viewer.scene.canvas.style.cursor = 'default';
            }
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
        
        // Click handler - zoom to entity and show details
        handler.setInputAction(function(click) {
            const pickedObject = viewer.scene.pick(click.position);

            if (Cesium.defined(pickedObject) && pickedObject.id) {
                const entity = pickedObject.id;
                const data = entity.customData || {};

                // Handle cluster click - zoom in to expand
                if (!data.type && entity.label && entity.label.text) {
                    const labelText = entity.label.text.getValue ? entity.label.text.getValue() : entity.label.text;
                    const count = parseInt(labelText);
                    if (!isNaN(count) && entity.position) {
                        // Get cluster position and zoom in closer to expand it
                        const position = entity.position.getValue ? entity.position.getValue(Cesium.JulianDate.now()) : entity.position;
                        const cartographic = Cesium.Cartographic.fromCartesian(position);
                        const currentHeight = viewer.camera.positionCartographic.height;
                        // Zoom to 40% of current height to expand cluster
                        const targetHeight = Math.max(currentHeight * 0.4, 50000);

                        viewer.camera.flyTo({
                            destination: Cesium.Cartesian3.fromRadians(
                                cartographic.longitude,
                                cartographic.latitude,
                                targetHeight
                            ),
                            duration: 1.5
                        });
                        return;
                    }
                }

                // Handle IXP click - show detail panel with connections
                if (data.type === 'ixp') {
                    showIXPDetails(data, entity);
                    return;
                }

                // Default: Zoom to entity
                viewer.flyTo(entity, {
                    duration: 1.5,
                    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-45), 500000)
                });
            } else {
                // Click on empty space - check if we should create a focus zone
                hideIXPDetails();

                // Get the click position on the globe
                const ray = viewer.camera.getPickRay(click.position);
                const globePosition = viewer.scene.globe.pick(ray, viewer.scene);

                if (globePosition) {
                    // Click was on the globe - create focus zone
                    createClickFocusZone(globePosition);
                } else {
                    // Click was in space - clear focus zone
                    clearFocusZone();
                }
            }
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
        
        // Update zoom level display
        viewer.camera.changed.addEventListener(() => {
            const height = viewer.camera.positionCartographic.height;
            let zoomText = 'GLOBAL';
            if (height < 500000) zoomText = 'STREET';
            else if (height < 2000000) zoomText = 'CITY';
            else if (height < 5000000) zoomText = 'REGION';
            else if (height < 15000000) zoomText = 'COUNTRY';
            document.getElementById('zoom-level').textContent = zoomText;
        });
        
        // Current highlight mode and active region
        let currentHighlightMode = 'default';
        let activeRegion = null;

        // Region definitions with camera positions (oblique view from south)
        const regionConfigs = {
            ukraine: {
                center: { lon: 32, lat: 48.5 },
                camera: { lon: 32, lat: 38, height: 1800000 },  // View from south
                pitch: -35,
                heading: 0,
                color: 'rgba(0,100,255,0.3)',
                borderColor: '#0066ff',
                label: 'UKRAINE',
                deepSources: ['liveuamap', 'deepstate', 'militaryland']
            },
            iran: {
                center: { lon: 53, lat: 32 },
                camera: { lon: 53, lat: 22, height: 2000000 },
                pitch: -35,
                heading: 0,
                color: 'rgba(255,100,0,0.3)',
                borderColor: '#ff6600',
                label: 'IRAN',
                deepSources: ['iranintl', 'tehrantimes']
            },
            israel: {
                center: { lon: 35, lat: 31.5 },
                camera: { lon: 35, lat: 25, height: 800000 },
                pitch: -40,
                heading: 0,
                color: 'rgba(0,100,200,0.3)',
                borderColor: '#0066cc',
                label: 'ISRAEL',
                deepSources: ['jpost', 'timesofisrael', 'ynet']
            },
            taiwan: {
                center: { lon: 121, lat: 23.5 },
                camera: { lon: 121, lat: 16, height: 1200000 },
                pitch: -40,
                heading: 0,
                color: 'rgba(0,200,100,0.3)',
                borderColor: '#00cc66',
                label: 'TAIWAN',
                deepSources: ['focustaiwan', 'taipeitimes']
            },
            greenland: {
                center: { lon: -42, lat: 72 },
                camera: { lon: -42, lat: 58, height: 2500000 },
                pitch: -30,
                heading: 0,
                color: 'rgba(100,200,255,0.3)',
                borderColor: '#66ccff',
                label: 'GREENLAND',
                deepSources: ['sermitsiaq', 'arctictoday']
            },
            cuba: {
                center: { lon: -79.5, lat: 22 },
                camera: { lon: -79.5, lat: 15, height: 1000000 },
                pitch: -40,
                heading: 0,
                color: 'rgba(255,50,50,0.3)',
                borderColor: '#ff3333',
                label: 'CUBA',
                deepSources: ['14ymedio', 'diariodecuba']
            },
            germany: {
                center: { lon: 10.5, lat: 51 },
                camera: { lon: 10.5, lat: 44, height: 1500000 },
                pitch: -35,
                heading: 0,
                color: 'rgba(255,204,0,0.25)',
                borderColor: '#ffcc00',
                label: 'GERMANY',
                deepSources: ['dw', 'spiegel', 'tagesschau']
            },
            hamburg: {
                center: { lon: 9.99, lat: 53.55 },
                camera: { lon: 9.99, lat: 52.5, height: 200000 },
                pitch: -45,
                heading: 0,
                color: 'rgba(0,150,255,0.3)',
                borderColor: '#0099ff',
                label: 'HAMBURG PORT',
                deepSources: ['hamburger-abendblatt', 'ndr']
            }
        };

        // Highlight mode configurations
        const highlightModes = {
            default: {
                zones: ['ukraine', 'iran', 'israel', 'taiwan', 'greenland', 'cuba'],
                emphasis: null
            },
            network: {
                zones: [],
                layers: ['cables', 'ixps', 'dataflow'],
                emphasis: 'infrastructure'
            },
            us_forces: {
                zones: ['iran', 'taiwan', 'greenland'],
                bases: true,
                carriers: true,
                emphasis: 'us_military'
            },
            russia: {
                zones: ['ukraine'],
                adversary: 'russia',
                emphasis: 'russia'
            },
            china: {
                zones: ['taiwan'],
                adversary: 'china',
                emphasis: 'china'
            },
            germany: {
                zones: ['germany', 'hamburg'],
                layers: ['german_infra', 'aisVessels'],
                emphasis: 'germany',
                germanWaters: true
            }
        };

        // Fly to region with proper camera angle
        function flyToRegion(regionId) {
            const region = regionConfigs[regionId];
            if (!region) return;

            activeRegion = regionId;

            // Calculate camera position for oblique view
            const cam = region.camera;

            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, cam.height),
                duration: 2,
                orientation: {
                    heading: Cesium.Math.toRadians(region.heading),
                    pitch: Cesium.Math.toRadians(region.pitch),
                    roll: 0
                }
            });

            // Update status bar
            document.getElementById('zoom-level').textContent = region.label;

            // Highlight the region zone if it exists
            highlightRegionZone(regionId);

            console.log(`[REGION] Flying to ${region.label}`);
        }

        // Fly to Hamburg port specifically
        function flyToHamburg() {
            flyToRegion('hamburg');

            // Load Hamburg-specific AIS data
            setTimeout(() => {
                loadGermanWatersVessels();
            }, 1000);
        }

        // German infrastructure layer state
        let germanInfraLayerActive = false;
        let germanInfraEntities = [];

        // Toggle German infrastructure layer
        function toggleGermanInfraLayer() {
            germanInfraLayerActive = !germanInfraLayerActive;
            const btn = document.getElementById('btn-german-infra');
            if (btn) {
                btn.classList.toggle('active', germanInfraLayerActive);
            }

            if (germanInfraLayerActive) {
                loadGermanInfrastructure();
            } else {
                // Remove German infrastructure entities
                germanInfraEntities.forEach(entity => {
                    viewer.entities.remove(entity);
                });
                germanInfraEntities = [];
            }
        }

        // Load German infrastructure from API
        let germanInfraLoading = false;
        async function loadGermanInfrastructure() {
            if (germanInfraLoading) return;
            germanInfraLoading = true;

            try {
                const response = await fetch('/api/german/infrastructure');
                if (!response.ok) throw new Error('Failed to fetch');
                const data = await response.json();

                // Clear existing
                germanInfraEntities.forEach(entity => {
                    try { viewer.entities.remove(entity); } catch(e) {}
                });
                germanInfraEntities = [];

                // Limit total entities to prevent memory issues
                const MAX_ENTITIES = 50;
                let entityCount = 0;

                // Add airbases (limit to 20)
                if (data.airbases && entityCount < MAX_ENTITIES) {
                    data.airbases.slice(0, 20).forEach(base => {
                        if (!base.lat || !base.lon) return;

                        let color = Cesium.Color.CYAN;
                        if (base.type?.includes('nato')) color = Cesium.Color.BLUE;
                        if (base.type?.includes('nuclear')) color = Cesium.Color.RED;
                        if (base.operator === 'USAF') color = Cesium.Color.fromCssColorString('#0044ff');

                        const entity = viewer.entities.add({
                            position: Cesium.Cartesian3.fromDegrees(base.lon, base.lat),
                            point: {
                                pixelSize: 10,
                                color: color,
                                outlineColor: Cesium.Color.WHITE,
                                outlineWidth: 2
                            },
                            label: {
                                text: base.name || 'Airbase',
                                font: '10px sans-serif',
                                fillColor: Cesium.Color.WHITE,
                                outlineColor: Cesium.Color.BLACK,
                                outlineWidth: 2,
                                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                                pixelOffset: new Cesium.Cartesian2(0, -12)
                            },
                            properties: {
                                type: 'german_airbase',
                                data: base
                            }
                        });
                        germanInfraEntities.push(entity);
                        entityCount++;
                    });
                }

                // Add harbours (limit to 15)
                if (data.harbours && entityCount < MAX_ENTITIES) {
                    data.harbours.slice(0, 15).forEach(harbour => {
                        if (!harbour.lat || !harbour.lon) return;

                        const entity = viewer.entities.add({
                            position: Cesium.Cartesian3.fromDegrees(harbour.lon, harbour.lat),
                            point: {
                                pixelSize: 8,
                                color: Cesium.Color.fromCssColorString('#00ccff'),
                                outlineColor: Cesium.Color.WHITE,
                                outlineWidth: 1
                            },
                            label: {
                                text: harbour.name || 'Harbour',
                                font: '9px sans-serif',
                                fillColor: Cesium.Color.CYAN,
                                outlineColor: Cesium.Color.BLACK,
                                outlineWidth: 1,
                                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                                pixelOffset: new Cesium.Cartesian2(0, -10)
                            },
                            properties: {
                                type: 'german_harbour',
                                data: harbour
                            }
                        });
                        germanInfraEntities.push(entity);
                        entityCount++;
                    });
                }

                // Add naval bases (limit to 10)
                if (data.naval_bases && entityCount < MAX_ENTITIES) {
                    data.naval_bases.slice(0, 10).forEach(base => {
                        if (!base.lat || !base.lon) return;

                        const entity = viewer.entities.add({
                            position: Cesium.Cartesian3.fromDegrees(base.lon, base.lat),
                            point: {
                                pixelSize: 10,
                                color: Cesium.Color.fromCssColorString('#ff6600'),
                                outlineColor: Cesium.Color.WHITE,
                                outlineWidth: 2
                            },
                            label: {
                                text: base.name || 'Naval Base',
                                font: '10px sans-serif',
                                fillColor: Cesium.Color.ORANGE,
                                outlineColor: Cesium.Color.BLACK,
                                outlineWidth: 2,
                                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                                pixelOffset: new Cesium.Cartesian2(0, -12)
                            },
                            properties: {
                                type: 'german_naval_base',
                                data: base
                            }
                        });
                        germanInfraEntities.push(entity);
                        entityCount++;
                    });
                }

                console.log(`[GERMAN-INFRA] Loaded ${germanInfraEntities.length} infrastructure points`);
            } catch (error) {
                console.error('[GERMAN-INFRA] Error loading infrastructure:', error);
            } finally {
                germanInfraLoading = false;
            }
        }

        // Load German waters vessels
        async function loadGermanWatersVessels() {
            try {
                const response = await fetch('/api/hamburg/vessels');
                const data = await response.json();

                updateGermanWatersPanel(data);

                console.log(`[GERMAN-WATERS] Loaded ${data.count} vessels in German waters`);
            } catch (error) {
                console.error('[GERMAN-WATERS] Error loading vessels:', error);
            }
        }

        // Update German waters panel
        function updateGermanWatersPanel(data) {
            const container = document.getElementById('german-waters-vessels');
            const countEl = document.getElementById('german-waters-count');

            if (!data) {
                if (countEl) countEl.textContent = '0';
                if (container) container.innerHTML = '<div style="color:var(--text-dim);">Loading...</div>';
                return;
            }

            if (countEl) countEl.textContent = Math.min(data.count || 0, 999);

            if (!container) return;

            if (!data.vessels || data.vessels.length === 0) {
                container.innerHTML = '<div style="color:var(--text-dim);">No vessels in German waters</div>';
                return;
            }

            // Limit to 10 vessels to prevent rendering issues
            container.innerHTML = data.vessels.slice(0, 10).map(v => `
                <div style="display:flex; justify-content:space-between; padding:4px 6px; background:rgba(0,50,100,0.3); border-radius:3px; margin-bottom:4px; border-left:2px solid ${v.germanZone === 'hamburg_port' ? '#00ff88' : '#0099ff'};">
                    <div>
                        <div style="font-weight:500; color:var(--text);">${v.name || 'Unknown'}</div>
                        <div style="font-size:0.6rem; color:var(--text-dim);">${v.shipTypeName || 'Unknown'} | ${v.germanZone || 'German waters'}</div>
                    </div>
                    <div style="text-align:right;">
                        <div style="color:var(--accent);">${v.speed?.toFixed(1) || '0'} kn</div>
                        <div style="font-size:0.55rem; color:var(--text-dim);">${v.destination || '-'}</div>
                    </div>
                </div>
            `).join('');
        }

        // Entities panel state
        let entitiesPanelVisible = false;
        let entitiesLoadPending = false;
        let lastEntitiesLoad = 0;
        const ENTITIES_LOAD_COOLDOWN = 5000; // 5 seconds min between loads

        // Toggle entities panel
        function toggleEntitiesPanel() {
            entitiesPanelVisible = !entitiesPanelVisible;
            const panel = document.getElementById('entities-panel');
            if (panel) {
                panel.style.display = entitiesPanelVisible ? 'block' : 'none';
            }
            if (entitiesPanelVisible) {
                loadEntitiesOfInterest();
            }
        }

        // Load entities of interest (with debounce)
        async function loadEntitiesOfInterest() {
            // Prevent too frequent loads
            const now = Date.now();
            if (now - lastEntitiesLoad < ENTITIES_LOAD_COOLDOWN) {
                return;
            }
            if (entitiesLoadPending) return;

            entitiesLoadPending = true;
            lastEntitiesLoad = now;

            try {
                const [entitiesRes, analysesRes, germanRes] = await Promise.all([
                    fetch('/api/entities'),
                    fetch('/api/entities/analyses?limit=5'),
                    fetch('/api/hamburg/vessels')
                ]);

                if (!entitiesRes.ok || !analysesRes.ok || !germanRes.ok) {
                    throw new Error('API request failed');
                }

                const entities = await entitiesRes.json();
                const analyses = await analysesRes.json();
                const germanVessels = await germanRes.json();

                updateEntitiesPanel(entities, analyses, germanVessels);
            } catch (error) {
                console.error('[ENTITIES] Error loading entities:', error);
            } finally {
                entitiesLoadPending = false;
            }
        }

        // Update entities panel
        function updateEntitiesPanel(entities, analyses, germanVessels) {
            if (!entities || !analyses) return;

            // Update counts
            const totalCount = Math.min((entities.flights?.count || 0) + (entities.vessels?.count || 0), 999);
            const countEl = document.getElementById('entities-count');
            if (countEl) countEl.textContent = totalCount;

            const flightsCountEl = document.getElementById('priority-flights-count');
            if (flightsCountEl) flightsCountEl.textContent = entities.flights?.count || 0;

            const vesselsCountEl = document.getElementById('priority-vessels-count');
            if (vesselsCountEl) vesselsCountEl.textContent = entities.vessels?.count || 0;

            // Update flights list
            const flightsList = document.getElementById('priority-flights-list');
            if (flightsList) {
                const flights = entities.flights?.items || [];
                if (flights.length === 0) {
                    flightsList.innerHTML = '<div style="color:var(--text-dim);">No priority flights tracked</div>';
                } else {
                    flightsList.innerHTML = flights.slice(0, 10).map(f => {
                        const priorityColor = f.matchInfo?.priority === 'CRITICAL' ? '#ff0040' :
                                              f.matchInfo?.priority === 'HIGH' ? '#ffa000' : '#00c8ff';
                        return `
                            <div style="display:flex; justify-content:space-between; padding:4px 6px; background:rgba(0,30,60,0.5); border-radius:3px; margin-bottom:4px; border-left:3px solid ${priorityColor};">
                                <div>
                                    <div style="font-weight:600; color:var(--text);">${f.callsign || 'Unknown'}</div>
                                    <div style="font-size:0.55rem; color:var(--text-dim);">${f.matchInfo?.type || f.category || 'Unknown'}</div>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-size:0.6rem; color:${priorityColor};">${f.matchInfo?.priority || 'LOW'}</div>
                                    <div style="font-size:0.5rem; color:var(--text-dim);">${f.region?.name || '-'}</div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            // Update vessels list
            const vesselsList = document.getElementById('priority-vessels-list');
            if (vesselsList) {
                const vessels = entities.vessels?.items || [];
                if (vessels.length === 0) {
                    vesselsList.innerHTML = '<div style="color:var(--text-dim);">No priority vessels tracked</div>';
                } else {
                    vesselsList.innerHTML = vessels.slice(0, 8).map(v => {
                        const priorityColor = v.matchInfo?.priority === 'CRITICAL' ? '#ff0040' :
                                              v.matchInfo?.priority === 'HIGH' ? '#ffa000' : '#00c8ff';
                        return `
                            <div style="display:flex; justify-content:space-between; padding:4px 6px; background:rgba(0,30,60,0.5); border-radius:3px; margin-bottom:4px; border-left:3px solid ${priorityColor};">
                                <div>
                                    <div style="font-weight:500; color:var(--text);">${v.name || 'Unknown'}</div>
                                    <div style="font-size:0.55rem; color:var(--text-dim);">${v.matchInfo?.type || v.shipTypeName || 'Unknown'}</div>
                                </div>
                                <div style="text-align:right;">
                                    <div style="font-size:0.6rem; color:${priorityColor};">${v.matchInfo?.priority || 'LOW'}</div>
                                    <div style="font-size:0.5rem; color:var(--text-dim);">${v.germanWaters ? 'DE' : '-'}</div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            // Update German waters
            updateGermanWatersPanel(germanVessels);

            // Update analysis queue
            const queueEl = document.getElementById('analysis-queue');
            if (queueEl && analyses.summary) {
                queueEl.textContent = `Queue: ${analyses.summary.queueLength || 0}`;
            }

            // Update AI analyses
            const analysisContainer = document.getElementById('entity-analysis');
            if (analysisContainer) {
                const recentAnalyses = analyses.analyses || [];
                if (recentAnalyses.length === 0) {
                    analysisContainer.innerHTML = '<div style="color:var(--text-dim);">No recent AI analyses</div>';
                } else {
                    analysisContainer.innerHTML = recentAnalyses.slice(0, 5).map(a => {
                        const sigColor = a.analysis?.significance === 'CRITICAL' ? '#ff0040' :
                                         a.analysis?.significance === 'HIGH' ? '#ffa000' :
                                         a.analysis?.significance === 'MEDIUM' ? '#ffcc00' : '#00c8ff';
                        return `
                            <div style="padding:6px; background:rgba(0,40,80,0.4); border-radius:4px; margin-bottom:6px; border-left:2px solid ${sigColor};">
                                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                                    <span style="font-weight:500; color:var(--text);">${a.entityId || 'Unknown'}</span>
                                    <span style="font-size:0.55rem; color:${sigColor};">${a.analysis?.significance || 'UNKNOWN'}</span>
                                </div>
                                <div style="font-size:0.55rem; color:var(--text-dim); margin-bottom:2px;">${a.trigger}</div>
                                <div style="font-size:0.6rem; color:var(--text);">${a.analysis?.assessment?.substring(0, 100) || 'No assessment'}...</div>
                            </div>
                        `;
                    }).join('');
                }
            }
        }

        // Entity to hold the focus zone
        let focusZoneEntity = null;
        let focusZonePulseInterval = null;

        // Highlight a specific region zone
        function highlightRegionZone(regionId) {
            const region = regionConfigs[regionId];
            if (!region) return;

            // Remove previous focus zone
            clearFocusZone();

            // Create pulsing ring around region
            const pulseRadius = region.camera.height / 3;

            focusZoneEntity = viewer.entities.add({
                position: Cesium.Cartesian3.fromDegrees(region.center.lon, region.center.lat),
                ellipse: {
                    semiMajorAxis: pulseRadius,
                    semiMinorAxis: pulseRadius,
                    material: new Cesium.ColorMaterialProperty(
                        Cesium.Color.fromCssColorString(region.borderColor).withAlpha(0.2)
                    ),
                    outline: true,
                    outlineColor: Cesium.Color.fromCssColorString(region.borderColor),
                    outlineWidth: 2,
                    height: 0
                },
                label: {
                    text: region.label,
                    font: '14px monospace',
                    fillColor: Cesium.Color.fromCssColorString(region.borderColor),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    pixelOffset: new Cesium.Cartesian2(0, -pulseRadius / 10000)
                }
            });

            // Animate pulse effect
            let pulsePhase = 0;
            focusZonePulseInterval = setInterval(() => {
                if (!focusZoneEntity || !focusZoneEntity.ellipse) return;
                pulsePhase += 0.1;
                const scale = 1 + 0.1 * Math.sin(pulsePhase);
                const alpha = 0.15 + 0.1 * Math.sin(pulsePhase);
                focusZoneEntity.ellipse.semiMajorAxis = pulseRadius * scale;
                focusZoneEntity.ellipse.semiMinorAxis = pulseRadius * scale;
                focusZoneEntity.ellipse.material = new Cesium.ColorMaterialProperty(
                    Cesium.Color.fromCssColorString(region.borderColor).withAlpha(alpha)
                );
            }, 50);

            console.log(`[ZONE] Highlighting ${region.label} zone`);
        }

        // Clear focus zone
        function clearFocusZone() {
            if (focusZonePulseInterval) {
                clearInterval(focusZonePulseInterval);
                focusZonePulseInterval = null;
            }
            if (focusZoneEntity) {
                viewer.entities.remove(focusZoneEntity);
                focusZoneEntity = null;
            }
            activeRegion = null;
        }

        // Click-to-focus: create a focus zone at clicked location
        let clickFocusEnabled = true;

        function createClickFocusZone(cartesian) {
            if (!clickFocusEnabled) return;

            // Clear existing focus zone
            clearFocusZone();

            // Convert to geographic coordinates
            const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            const lon = Cesium.Math.toDegrees(cartographic.longitude);
            const lat = Cesium.Math.toDegrees(cartographic.latitude);

            // Get current camera height to scale the zone
            const height = viewer.camera.positionCartographic.height;
            const zoneRadius = Math.max(height / 10, 50000); // Min 50km radius

            focusZoneEntity = viewer.entities.add({
                position: cartesian,
                ellipse: {
                    semiMajorAxis: zoneRadius,
                    semiMinorAxis: zoneRadius,
                    material: Cesium.Color.CYAN.withAlpha(0.15),
                    outline: true,
                    outlineColor: Cesium.Color.CYAN,
                    outlineWidth: 2,
                    height: 0
                },
                label: {
                    text: `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
                    font: '12px monospace',
                    fillColor: Cesium.Color.CYAN,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.TOP,
                    pixelOffset: new Cesium.Cartesian2(0, 15)
                }
            });

            // Animate pulse
            let pulsePhase = 0;
            focusZonePulseInterval = setInterval(() => {
                if (!focusZoneEntity || !focusZoneEntity.ellipse) return;
                pulsePhase += 0.08;
                const scale = 1 + 0.15 * Math.sin(pulsePhase);
                const alpha = 0.1 + 0.08 * Math.sin(pulsePhase);
                focusZoneEntity.ellipse.semiMajorAxis = zoneRadius * scale;
                focusZoneEntity.ellipse.semiMinorAxis = zoneRadius * scale;
                focusZoneEntity.ellipse.material = Cesium.Color.CYAN.withAlpha(alpha);
            }, 50);

            // Fly to clicked location with oblique view
            const targetHeight = Math.max(height * 0.5, 200000);
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lon, lat - (targetHeight / 200000), targetHeight),
                duration: 1.5,
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-40),
                    roll: 0
                }
            });

            console.log(`[FOCUS] Created focus zone at ${lat.toFixed(2)}°N, ${lon.toFixed(2)}°E`);
        }

        // Set highlight mode
        function setHighlightMode(mode) {
            currentHighlightMode = mode;
            const config = highlightModes[mode];
            if (!config) return;

            console.log(`[MODE] Switching to: ${mode}`);

            // Clear current focus zone when switching modes
            clearFocusZone();

            if (mode === 'default') {
                // Reset to default view
                resetView();
            } else if (mode === 'network') {
                // Enable network visualization layers
                if (!layerSettings.cables?.visible) toggleMaritimeLayer('cables');
                if (!layerSettings.ixps?.visible) toggleLayer('ixps');
                if (!dataFlowSystem.enabled) toggleDataFlow();

                // Fly to view centered on major internet infrastructure
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(0, 35, 15000000),
                    duration: 2,
                    orientation: {
                        heading: 0,
                        pitch: Cesium.Math.toRadians(-45),
                        roll: 0
                    }
                });
                document.getElementById('zoom-level').textContent = 'NETWORK';
            } else if (mode === 'us_forces') {
                // Show US military presence globally
                // Fly to view of US global military footprint (Atlantic-centric)
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(-30, 30, 20000000),
                    duration: 2,
                    orientation: {
                        heading: 0,
                        pitch: Cesium.Math.toRadians(-60),
                        roll: 0
                    }
                });
                document.getElementById('zoom-level').textContent = 'US FORCES';

                // Ensure military flights are visible
                if (layerSettings.flights === false) {
                    layerSettings.flights = true;
                    // Toggle would be handled by the layer system
                }
            } else if (mode === 'russia') {
                // Focus on Russia/Ukraine theater
                flyToRegion('ukraine');
                document.getElementById('zoom-level').textContent = 'RUSSIA';
            } else if (mode === 'china') {
                // Focus on China/Taiwan theater
                flyToRegion('taiwan');
                document.getElementById('zoom-level').textContent = 'CHINA';
            }
        }

        // Legacy flyTo for compatibility
        function flyTo(location) {
            if (regionConfigs[location]) {
                flyToRegion(location);
            }
        }

        // Reset view to global overview
        function resetView() {
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(20, 30, 25000000),
                duration: 1.5,
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-90),
                    roll: 0
                }
            });
            // Clear zone selection and focus zone
            document.getElementById('zone-select').value = '';
            clearFocusZone();
            activeRegion = null;
            document.getElementById('zoom-level').textContent = 'GLOBAL';
        }
        
        // Create aircraft symbol canvas based on type
        function createAircraftSymbol(category, color, heading = 0) {
            const canvas = document.createElement('canvas');
            canvas.width = 48;
            canvas.height = 48;
            const ctx = canvas.getContext('2d');
            const cx = 24, cy = 24;

            // Rotate for heading
            ctx.translate(cx, cy);
            ctx.rotate((heading - 90) * Math.PI / 180);
            ctx.translate(-cx, -cy);

            // Draw glow effect
            ctx.shadowColor = color;
            ctx.shadowBlur = 8;

            ctx.fillStyle = color;
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1.5;

            switch(category) {
                case 'bombers':
                case 'stealth-bomber':
                    // B-2 style flying wing silhouette
                    ctx.beginPath();
                    ctx.moveTo(24, 8);   // nose
                    ctx.lineTo(44, 28);  // right wing tip
                    ctx.lineTo(38, 32);  // right engine
                    ctx.lineTo(28, 28);  // right body
                    ctx.lineTo(24, 38);  // tail
                    ctx.lineTo(20, 28);  // left body
                    ctx.lineTo(10, 32);  // left engine
                    ctx.lineTo(4, 28);   // left wing tip
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    break;

                case 'fighter':
                    // Fighter jet silhouette (F-16 style)
                    ctx.beginPath();
                    ctx.moveTo(24, 6);   // nose
                    ctx.lineTo(28, 18);  // right fuselage
                    ctx.lineTo(42, 28);  // right wing
                    ctx.lineTo(28, 26);  // right wing root
                    ctx.lineTo(30, 38);  // right tail
                    ctx.lineTo(24, 42);  // tail
                    ctx.lineTo(18, 38);  // left tail
                    ctx.lineTo(20, 26);  // left wing root
                    ctx.lineTo(6, 28);   // left wing
                    ctx.lineTo(20, 18);  // left fuselage
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    break;

                case 'tankers':
                    // Large aircraft silhouette (KC-135 style)
                    ctx.beginPath();
                    ctx.moveTo(24, 6);   // nose
                    ctx.lineTo(28, 16);  // right cockpit
                    ctx.lineTo(30, 20);  // right body
                    ctx.lineTo(44, 24);  // right wing
                    ctx.lineTo(30, 26);  // right wing root
                    ctx.lineTo(30, 36);  // right body rear
                    ctx.lineTo(34, 40);  // right stabilizer
                    ctx.lineTo(28, 38);  // right tail
                    ctx.lineTo(24, 44);  // tail fin
                    ctx.lineTo(20, 38);  // left tail
                    ctx.lineTo(14, 40);  // left stabilizer
                    ctx.lineTo(18, 36);  // left body rear
                    ctx.lineTo(18, 26);  // left wing root
                    ctx.lineTo(4, 24);   // left wing
                    ctx.lineTo(18, 20);  // left body
                    ctx.lineTo(20, 16);  // left cockpit
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    break;

                case 'surveillance':
                case 'electronicWarfare':
                    // Surveillance aircraft (E-3/RC-135 style with dome)
                    ctx.beginPath();
                    ctx.moveTo(24, 8);
                    ctx.lineTo(28, 16);
                    ctx.lineTo(30, 20);
                    ctx.lineTo(42, 24);
                    ctx.lineTo(30, 26);
                    ctx.lineTo(30, 36);
                    ctx.lineTo(32, 40);
                    ctx.lineTo(24, 42);
                    ctx.lineTo(16, 40);
                    ctx.lineTo(18, 36);
                    ctx.lineTo(18, 26);
                    ctx.lineTo(6, 24);
                    ctx.lineTo(18, 20);
                    ctx.lineTo(20, 16);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    // Radar dome
                    ctx.beginPath();
                    ctx.arc(24, 22, 6, 0, Math.PI * 2);
                    ctx.fillStyle = '#fff';
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = color;
                    break;

                case 'transport':
                    // Transport (C-17 style)
                    ctx.beginPath();
                    ctx.moveTo(24, 6);
                    ctx.lineTo(30, 14);
                    ctx.lineTo(32, 20);
                    ctx.lineTo(44, 26);
                    ctx.lineTo(32, 28);
                    ctx.lineTo(32, 38);
                    ctx.lineTo(38, 42);
                    ctx.lineTo(24, 44);
                    ctx.lineTo(10, 42);
                    ctx.lineTo(16, 38);
                    ctx.lineTo(16, 28);
                    ctx.lineTo(4, 26);
                    ctx.lineTo(16, 20);
                    ctx.lineTo(18, 14);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    break;

                case 'uav':
                    // Drone (Global Hawk/Reaper style)
                    ctx.beginPath();
                    ctx.moveTo(24, 4);   // nose (long)
                    ctx.lineTo(26, 20);
                    ctx.lineTo(44, 28);  // right wing (long span)
                    ctx.lineTo(26, 30);
                    ctx.lineTo(26, 38);
                    ctx.lineTo(32, 44);  // V-tail right
                    ctx.lineTo(24, 40);
                    ctx.lineTo(16, 44);  // V-tail left
                    ctx.lineTo(22, 38);
                    ctx.lineTo(22, 30);
                    ctx.lineTo(4, 28);   // left wing
                    ctx.lineTo(22, 20);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    break;

                case 'specialOps':
                    // Special ops (AC-130 gunship style)
                    ctx.beginPath();
                    ctx.moveTo(24, 8);
                    ctx.lineTo(28, 14);
                    ctx.lineTo(44, 22);  // right wing
                    ctx.lineTo(28, 24);
                    ctx.lineTo(30, 36);
                    ctx.lineTo(34, 40);
                    ctx.lineTo(24, 42);
                    ctx.lineTo(14, 40);
                    ctx.lineTo(18, 36);
                    ctx.lineTo(20, 24);
                    ctx.lineTo(4, 22);   // left wing
                    ctx.lineTo(20, 14);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
                    // Gun pods indicator
                    ctx.fillStyle = '#f00';
                    ctx.fillRect(18, 26, 4, 8);
                    ctx.fillStyle = color;
                    break;

                default:
                    // Generic aircraft
                    ctx.beginPath();
                    ctx.moveTo(24, 8);
                    ctx.lineTo(28, 18);
                    ctx.lineTo(40, 24);
                    ctx.lineTo(28, 26);
                    ctx.lineTo(28, 36);
                    ctx.lineTo(32, 40);
                    ctx.lineTo(24, 42);
                    ctx.lineTo(16, 40);
                    ctx.lineTo(20, 36);
                    ctx.lineTo(20, 26);
                    ctx.lineTo(8, 24);
                    ctx.lineTo(20, 18);
                    ctx.closePath();
                    ctx.fill();
                    ctx.stroke();
            }

            return canvas.toDataURL();
        }

        // Add flight marker with route tracking
        function addFlight(flight) {
            if (!flight.latitude || !flight.longitude) return;

            const id = flight.icao24 || flight.callsign;
            const altitude = (flight.altitude || 30000) * 0.3048;
            const currentPos = {
                lon: flight.longitude,
                lat: flight.latitude,
                alt: altitude,
                time: Date.now()
            };

            // Update flight history for route tracking
            if (!flightHistory.has(id)) {
                flightHistory.set(id, []);
            }
            const history = flightHistory.get(id);

            // Only add if position changed significantly (avoid duplicates)
            const lastPos = history[history.length - 1];
            if (!lastPos ||
                Math.abs(lastPos.lon - currentPos.lon) > 0.01 ||
                Math.abs(lastPos.lat - currentPos.lat) > 0.01) {
                history.push(currentPos);
                if (history.length > MAX_ROUTE_POSITIONS) {
                    history.shift();
                }
            }

            const color = flight.threatLevel === 'CRITICAL' ? Cesium.Color.fromCssColorString('#ff0040') :
                         flight.threatLevel === 'HIGH' ? Cesium.Color.ORANGE :
                         flight.threatLevel === 'MEDIUM' ? Cesium.Color.YELLOW :
                         Cesium.Color.CYAN;

            const colorHex = flight.threatLevel === 'CRITICAL' ? '#ff0040' :
                            flight.threatLevel === 'HIGH' ? '#ffa500' :
                            flight.threatLevel === 'MEDIUM' ? '#ffff00' : '#00ffff';

            const position = Cesium.Cartesian3.fromDegrees(flight.longitude, flight.latitude, altitude);
            const aircraftImage = createAircraftSymbol(
                flight.category || 'unknown',
                colorHex,
                flight.heading || 0
            );
            const customData = {
                type: 'flight',
                callsign: flight.callsign,
                icao24: flight.icao24,
                altitude: flight.altitude,
                velocity: flight.velocity,
                heading: flight.heading,
                origin: flight.origin,
                category: flight.category || 'unknown',
                aircraftType: flight.aircraftType || flight.category,
                threatLevel: flight.threatLevel,
                region: flight.region?.name || 'Unknown',
                routeLength: history.length
            };

            // Build route trail positions (if enough history)
            let routePositions = null;
            if (history.length > 1) {
                const positions = [];
                history.forEach(pos => { positions.push(pos.lon, pos.lat, pos.alt); });
                routePositions = Cesium.Cartesian3.fromDegreesArrayHeights(positions);
            }
            const routeMaterial = () => new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.2, color: color.withAlpha(0.6) });

            // Update in place if the entity already exists → no remove/add churn, far less GC
            const existing = flightEntities.get(id);
            if (existing) {
                existing.position = position;
                existing.billboard.image = aircraftImage;
                existing.label.text = flight.callsign || '';
                existing.label.fillColor = color;
                existing.customData = customData;
                if (routePositions) {
                    const r = flightRoutes.get(id);
                    if (r && r.polyline) {
                        r.polyline.positions = routePositions;
                        r.polyline.material = routeMaterial();
                    } else {
                        flightRoutes.set(id, viewer.entities.add({
                            id: `route-${id}`,
                            polyline: { positions: routePositions, width: 2, material: routeMaterial(), clampToGround: false }
                        }));
                    }
                }
                return id;
            }

            // --- Create new entity ---
            if (routePositions) {
                flightRoutes.set(id, viewer.entities.add({
                    id: `route-${id}`,
                    polyline: { positions: routePositions, width: 2, material: routeMaterial(), clampToGround: false }
                }));
            }

            const entity = flightClusterSource.entities.add({
                name: flight.callsign || flight.icao24,
                position: position,
                billboard: {
                    image: aircraftImage,
                    width: 32,
                    height: 32,
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.8, 5e6, 0.5),
                    pixelOffset: new Cesium.Cartesian2(0, 0),
                    disableDepthTestDistance: 0
                },
                label: {
                    text: flight.callsign || '',
                    font: '500 11px JetBrains Mono',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -24),
                    scaleByDistance: new Cesium.NearFarScalar(1e4, 1.2, 3e6, 0),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6),
                    disableDepthTestDistance: 0
                }
            });
            entity.customData = customData;
            flightEntities.set(id, entity);
            return id;
        }
        
        // Create seismic symbol
        function createSeismicSymbol(magnitude, colorHex) {
            const canvas = document.createElement('canvas');
            canvas.width = 40;
            canvas.height = 40;
            const ctx = canvas.getContext('2d');
            const cx = 20, cy = 20;

            ctx.shadowColor = colorHex;
            ctx.shadowBlur = 8;

            // Draw concentric seismic waves
            const rings = Math.min(Math.floor(magnitude / 2) + 1, 4);
            for (let i = rings; i > 0; i--) {
                const alpha = 0.3 + (rings - i) * 0.15;
                ctx.strokeStyle = colorHex;
                ctx.globalAlpha = alpha;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(cx, cy, 5 + i * 4, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Center point
            ctx.globalAlpha = 1;
            ctx.fillStyle = colorHex;
            ctx.beginPath();
            ctx.arc(cx, cy, 5, 0, Math.PI * 2);
            ctx.fill();

            // Cross/epicenter marker
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy);
            ctx.lineTo(cx + 3, cy);
            ctx.moveTo(cx, cy - 3);
            ctx.lineTo(cx, cy + 3);
            ctx.stroke();

            return canvas.toDataURL();
        }

        // Add earthquake marker with pulsing effect
        function addEarthquake(quake) {
            if (!quake.latitude || !quake.longitude) return;

            const id = quake.id;
            const existing = earthquakeEntities.get(id);
            // USGS revises magnitudes (preliminary → reviewed): skip only if unchanged,
            // otherwise update the existing entity in place.
            if (existing && existing.customData && existing.customData.magnitude === quake.magnitude) return;

            // Size based on magnitude
            const baseSize = Math.pow(2, quake.magnitude) * 2000;
            const size = Math.max(baseSize, 20000);

            // Color based on magnitude
            const colorHex = quake.magnitude >= 6 ? '#ff0040' :
                            quake.magnitude >= 5 ? '#ff8000' :
                            quake.magnitude >= 4 ? '#ffff00' : '#ffff80';

            const color = quake.magnitude >= 6 ? Cesium.Color.fromCssColorString('#ff0040') :
                         quake.magnitude >= 5 ? Cesium.Color.ORANGE :
                         quake.magnitude >= 4 ? Cesium.Color.YELLOW :
                         Cesium.Color.YELLOW.withAlpha(0.6);

            const seismicImage = createSeismicSymbol(quake.magnitude, colorHex);
            const customData = {
                type: 'earthquake',
                magnitude: quake.magnitude,
                place: quake.place,
                depth: quake.depth,
                time: quake.time,
                id: quake.id,
                url: quake.url
            };

            // Revised magnitude → update the existing entity in place (no remove/add)
            if (existing) {
                existing.name = 'M' + quake.magnitude.toFixed(1) + ' - ' + (quake.place || 'Unknown');
                existing.ellipse.semiMinorAxis = size;
                existing.ellipse.semiMajorAxis = size;
                existing.ellipse.material = color.withAlpha(0.25);
                existing.ellipse.outlineColor = color.withAlpha(0.6);
                existing.billboard.image = seismicImage;
                existing.label.text = 'M' + quake.magnitude.toFixed(1);
                existing.label.fillColor = color;
                existing.customData = customData;
                return;
            }

            // Create pulsing circle
            const entity = viewer.entities.add({
                name: 'M' + quake.magnitude.toFixed(1) + ' - ' + (quake.place || 'Unknown'),
                position: Cesium.Cartesian3.fromDegrees(quake.longitude, quake.latitude),
                ellipse: {
                    semiMinorAxis: size,
                    semiMajorAxis: size,
                    material: color.withAlpha(0.25),
                    outline: true,
                    outlineColor: color.withAlpha(0.6),
                    outlineWidth: 1
                },
                billboard: {
                    image: seismicImage,
                    width: 32,
                    height: 32,
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 5e6, 0.4),
                    disableDepthTestDistance: 0
                },
                label: {
                    text: 'M' + quake.magnitude.toFixed(1),
                    font: '500 10px JetBrains Mono',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(18, 0),
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 5e6, 0),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3e6),
                    disableDepthTestDistance: 0
                }
            });

            entity.customData = customData;
            earthquakeEntities.set(id, entity);
        }
        
        // Clear all markers
        function clearMarkers() {
            flightEntities.forEach(e => flightClusterSource.entities.remove(e));
            flightEntities.clear();
            flightRoutes.forEach(e => viewer.entities.remove(e));
            flightRoutes.clear();
            // Keep flight history for route continuity
            earthquakeEntities.forEach(e => viewer.entities.remove(e));
            earthquakeEntities.clear();
        }
        
        // ============================================
        // SOCKET.IO & DATA
        // ============================================
        
        const socket = io();
        let state = {};

        // Debounce helper — coalesce bursts of socket-driven re-renders
        function debounce(fn, ms) {
            let t = null;
            return function (...args) {
                if (t) clearTimeout(t);
                t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
            };
        }
        // updateQuickStats is called from several socket handlers; debounce so a
        // burst of updates triggers one stats recompute. (The 5s interval keeps it fresh.)
        const debouncedQuickStats = debounce(updateQuickStats, 250);

        socket.on('connect', () => {
            document.getElementById('conn-status').className = 'status-dot live';
            document.getElementById('conn-text').textContent = 'LIVE';
            // Update quick stats on connect
            setTimeout(updateQuickStats, 1000);
        });
        
        socket.on('disconnect', () => {
            document.getElementById('conn-status').className = 'status-dot critical';
            document.getElementById('conn-text').textContent = 'OFFLINE';
        });
        
        socket.on('initial-state', (data) => {
            state = { ...state, ...data };
            updateAll();
        });
        
        socket.on('flights-update', (data) => {
            state.flights = data;
            updateFlights();
            debouncedQuickStats();
        });
        
        socket.on('signals-update', (data) => {
            state.signals = data;
            updateSignals();
        });
        
        socket.on('seismic-update', (data) => {
            state.seismic = data;
            updateSeismic();
            debouncedQuickStats();
        });
        
        socket.on('space-weather-update', (data) => {
            state.spaceWeather = data;
            updateSpace();
        });
        
        socket.on('weather-update', (data) => {
            state.weather = data;
            updateWeather();
        });
        
        socket.on('news-update', (data) => {
            state.news = data;
            updateNews();
        });
        
        socket.on('alert', (alert) => {
            if (!state.alerts) state.alerts = [];
            state.alerts.unshift(alert);
            updateAlerts();
            debouncedQuickStats();
        });
        
        socket.on('ai-analysis-update', (data) => {
            state.aiAnalysis = data;
            updateAI();
        });
        
        function updateAll() {
            updateFlights();
            updateSignals();
            updateSeismic();
            updateSpace();
            updateWeather();
            updateNews();
            updateAlerts();
            updateAI();
            updateThreat();
        }
        
        function updateFlights() {
            const flights = state.flights?.flights || [];
            document.getElementById('flights-badge').textContent = flights.length;
            document.getElementById('data-sources').textContent = flights.length + ' TRACKED';

            // Update globe in place: refresh existing aircraft, add new, remove only the delta
            const seen = new Set();
            flights.slice(0, 300).forEach(f => {
                const id = addFlight(f);
                if (id) seen.add(id);
            });
            // Remove aircraft (and their routes) that are no longer present
            flightEntities.forEach((e, id) => {
                if (!seen.has(id)) {
                    flightClusterSource.entities.remove(e);
                    flightEntities.delete(id);
                    const r = flightRoutes.get(id);
                    if (r) { viewer.entities.remove(r); flightRoutes.delete(id); }
                }
            });
            // Note: flightHistory preserved for route continuity

            // Update list with more detail
            const sorted = [...flights].sort((a, b) => {
                const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
                return (order[a.threatLevel] || 4) - (order[b.threatLevel] || 4);
            }).slice(0, 15);

            // Get aircraft icon based on category
            const getIcon = (cat) => {
                switch(cat) {
                    case 'bombers':
                    case 'stealth-bomber': return '💣';
                    case 'tankers': return '⛽';
                    case 'surveillance': return '👁';
                    case 'transport': return '📦';
                    case 'specialOps': return '🎯';
                    case 'uav': return '🛸';
                    case 'fighter': return '⚔️';
                    case 'electronicWarfare': return '📡';
                    default: return '✈️';
                }
            };

            document.getElementById('flights-list').innerHTML = sorted.length ?
                sorted.map(f => `
                    <div class="list-item" style="cursor: pointer; display: flex; align-items: center; gap: 6px;" onclick="flyToFlight('${f.icao24 || f.callsign}')">
                        <span style="font-size: 0.8rem;">${getIcon(f.category)}</span>
                        <span class="callsign" style="flex: 1;">${f.callsign || f.icao24 || 'UNKN'}</span>
                        <span style="font-size: 0.6rem; color: #888; max-width: 65px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${f.aircraftType || f.category || ''}</span>
                        <span class="threat-dot ${f.threatLevel || 'LOW'}"></span>
                    </div>
                `).join('') : 'No flights';
        }

        // Fly to a specific flight
        function flyToFlight(id) {
            const flights = state.flights?.flights || [];
            const flight = flights.find(f => f.icao24 === id || f.callsign === id);
            if (flight && flight.latitude && flight.longitude) {
                viewer.camera.flyTo({
                    destination: Cesium.Cartesian3.fromDegrees(
                        flight.longitude,
                        flight.latitude,
                        ((flight.altitude || 30000) * 0.3048) + 500000
                    ),
                    duration: 1.5
                });
            }
        }
        
        function updateSignals() {
            const sig = state.signals || {};
            const zones = sig.gpsJammingZones?.length || 0;
            const regions = sig.summary?.activeRegions || [];
            
            document.getElementById('gps-jam').textContent = zones;
            document.getElementById('gps-regions').textContent = regions.length;
            
            const badge = document.getElementById('sigint-badge');
            const level = sig.summary?.threatLevel || 'CLEAR';
            badge.textContent = level;
            badge.className = 'badge badge-' + (level === 'HIGH' ? 'danger' : level === 'ELEVATED' ? 'warning' : 'normal');
        }
        
        function updateSeismic() {
            const seis = state.seismic || {};
            document.getElementById('quake-count').textContent = seis.count || 0;
            document.getElementById('quake-max').textContent = seis.summary?.maxMagnitude?.toFixed(1) || '0';
            document.getElementById('seismic-badge').textContent = seis.count || 0;
            
            // Update in place: add new (addEarthquake skips existing), remove only the delta
            const quakes = (seis.events || []).filter(e => e.magnitude >= 3.5).slice(0, 100);
            const seen = new Set();
            quakes.forEach(e => { if (e.id) seen.add(e.id); addEarthquake(e); });
            earthquakeEntities.forEach((ent, id) => {
                if (!seen.has(id)) { viewer.entities.remove(ent); earthquakeEntities.delete(id); }
            });

            console.log('Seismic:', quakes.length, 'quakes,', earthquakeEntities.size, 'entities');
        }
        
        function updateSpace() {
            const space = state.spaceWeather || {};
            document.getElementById('kp-index').textContent = space.current?.kpIndex ?? '--';
            document.getElementById('flares').textContent = space.solarFlares?.length || 0;
            
            const badge = document.getElementById('space-badge');
            const gLevel = space.current?.gLevel || 'G0';
            badge.textContent = gLevel;
            badge.className = 'badge badge-' + (gLevel >= 'G3' ? 'danger' : gLevel >= 'G1' ? 'warning' : 'normal');
        }
        
        // Weather station entities on globe
        const weatherEntities = new Map();

        function updateWeather() {
            const locations = state.weather?.locations || [];

            // Update weather markers in place (temp/icon change each cycle; positions are static)
            const seen = new Set();
            locations.forEach(loc => {
                if (!loc.lat || !loc.lon || !loc.weather?.current) return;
                seen.add(loc.id);

                const temp = loc.weather.current.temperature;
                const desc = loc.weather.current.weatherDescription || '';

                // Weather icon
                let icon = '🌡️';
                if (desc.toLowerCase().includes('rain')) icon = '🌧️';
                else if (desc.toLowerCase().includes('storm')) icon = '⛈️';
                else if (desc.toLowerCase().includes('cloud') || desc.toLowerCase().includes('overcast')) icon = '☁️';
                else if (desc.toLowerCase().includes('clear') || desc.toLowerCase().includes('sunny')) icon = '☀️';
                else if (desc.toLowerCase().includes('snow')) icon = '❄️';
                else if (desc.toLowerCase().includes('fog')) icon = '🌫️';

                const image = createWeatherCanvas(icon, Math.round(temp));
                const customData = {
                    type: 'weather',
                    name: loc.name,
                    temperature: temp,
                    description: desc,
                    wind: loc.weather.current.windSpeed,
                    humidity: loc.weather.current.humidity,
                    visibility: loc.weather.current.visibility
                };

                const existing = weatherEntities.get(loc.id);
                if (existing) {
                    existing.billboard.image = image;
                    existing.customData = customData;
                    return;
                }

                const entity = viewer.entities.add({
                    name: loc.name,
                    position: Cesium.Cartesian3.fromDegrees(loc.lon, loc.lat, 3000),
                    billboard: {
                        image: image,
                        scale: 0.6,
                        scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 3e6, 0.3),
                        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4e6)
                    }
                });
                entity.customData = customData;
                weatherEntities.set(loc.id, entity);
            });

            // Remove markers for locations no longer present
            weatherEntities.forEach((ent, id) => {
                if (!seen.has(id)) { viewer.entities.remove(ent); weatherEntities.delete(id); }
            });

            console.log('[WEATHER] Updated', locations.length, 'weather markers on globe');
        }

        // Create weather icon canvas
        function createWeatherCanvas(icon, temp) {
            const canvas = document.createElement('canvas');
            canvas.width = 64;
            canvas.height = 40;
            const ctx = canvas.getContext('2d');

            // Background
            ctx.fillStyle = 'rgba(0, 20, 40, 0.85)';
            ctx.beginPath();
            ctx.moveTo(4, 0);
            ctx.lineTo(60, 0);
            ctx.quadraticCurveTo(64, 0, 64, 4);
            ctx.lineTo(64, 36);
            ctx.quadraticCurveTo(64, 40, 60, 40);
            ctx.lineTo(4, 40);
            ctx.quadraticCurveTo(0, 40, 0, 36);
            ctx.lineTo(0, 4);
            ctx.quadraticCurveTo(0, 0, 4, 0);
            ctx.closePath();
            ctx.fill();

            // Border
            ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Icon
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(icon, 18, 26);

            // Temperature
            ctx.font = 'bold 13px monospace';
            ctx.fillStyle = temp > 30 ? '#ff6644' : temp > 20 ? '#ffaa00' : temp > 10 ? '#44ff88' : '#44aaff';
            ctx.fillText(temp + '°', 46, 26);

            return canvas;
        }

        // Wrap the symbol generators with memoization (aircraft heading bucketed to 5°)
        createBaseSymbol = _memoSymbol(createBaseSymbol, 'base', (t, c) => t + '|' + c);
        createAircraftSymbol = _memoSymbol(createAircraftSymbol, 'air', (cat, col, h = 0) => cat + '|' + col + '|' + (Math.round((h || 0) / 5) * 5));
        createSeismicSymbol = _memoSymbol(createSeismicSymbol, 'seis', (m, c) => (Math.round((m || 0) * 10) / 10) + '|' + c);
        createWeatherCanvas = _memoSymbol(createWeatherCanvas, 'wx', (icon, temp) => icon + '|' + temp);

        // ===== GDACS disaster layer (toggle on demand) =====
        const disasterEntities = new Map();
        let disastersVisible = false;
        let disastersLoaded = false;
        const DISASTER_EMOJI = { EQ: '💥', TC: '🌀', FL: '🌊', VO: '🌋', DR: '🏜️', WF: '🔥' };

        function createDisasterCanvas(emoji, severity) {
            const canvas = document.createElement('canvas');
            canvas.width = 40; canvas.height = 40;
            const ctx = canvas.getContext('2d');
            const ring = severity === 'CRITICAL' ? '#ff0040' : severity === 'HIGH' ? '#ffa500' : '#36d399';
            ctx.beginPath(); ctx.arc(20, 20, 15, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(0,15,30,0.8)'; ctx.fill();
            ctx.lineWidth = 2.5; ctx.strokeStyle = ring; ctx.stroke();
            ctx.font = '18px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(emoji, 20, 21);
            return canvas.toDataURL();
        }
        const _disasterImg = _memoSymbol(createDisasterCanvas, 'dis', (e, s) => e + '|' + s);

        async function loadGDACS() {
            try {
                const res = await fetch('/api/gdacs-monitor');
                const data = await res.json();
                const events = (data.events || []).filter(e => e.latitude != null && e.longitude != null);
                const seen = new Set();
                events.forEach(ev => {
                    seen.add(ev.id);
                    const img = _disasterImg(DISASTER_EMOJI[ev.typeCode] || '⚠️', ev.severity);
                    const customData = { type: 'disaster', eventType: ev.eventType, name: ev.name, country: ev.country, alertLevel: ev.alertLevel, severity: ev.severity, url: ev.url };
                    const existing = disasterEntities.get(ev.id);
                    if (existing) {
                        existing.billboard.image = img;
                        existing.show = disastersVisible;
                        existing.customData = customData;
                        return;
                    }
                    const entity = viewer.entities.add({
                        name: ev.name,
                        position: Cesium.Cartesian3.fromDegrees(ev.longitude, ev.latitude, 5000),
                        show: disastersVisible,
                        billboard: {
                            image: img, scale: 0.7,
                            scaleByDistance: new Cesium.NearFarScalar(1e5, 1, 2e7, 0.4),
                            disableDepthTestDistance: 0
                        }
                    });
                    entity.customData = customData;
                    disasterEntities.set(ev.id, entity);
                });
                disasterEntities.forEach((ent, id) => {
                    if (!seen.has(id)) { viewer.entities.remove(ent); disasterEntities.delete(id); }
                });
                if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
                console.log(`[GDACS] Rendered ${seen.size} disaster events`);
            } catch (error) {
                console.error('[GDACS] Load error:', error);
            }
        }

        // NASA EONET natural events share the DISASTERS toggle (distinct markers)
        const eonetEntities = new Map();
        const EONET_EMOJI = { Wildfires: '🔥', Volcanoes: '🌋', 'Severe Storms': '🌀', 'Sea and Lake Ice': '🧊' };

        async function loadEONET() {
            try {
                const res = await fetch('/api/eonet-monitor');
                const data = await res.json();
                const events = (data.events || []).filter(e => e.latitude != null && e.longitude != null);
                const seen = new Set();
                events.forEach(ev => {
                    seen.add(ev.id);
                    const sev = (ev.category === 'Volcanoes' || ev.category === 'Severe Storms') ? 'HIGH' : 'LOW';
                    const img = _disasterImg(EONET_EMOJI[ev.category] || '🌎', sev);
                    const customData = { type: 'eonet', eventType: ev.category, name: ev.title, source: ev.source, url: ev.url };
                    const existing = eonetEntities.get(ev.id);
                    if (existing) {
                        existing.billboard.image = img;
                        existing.show = disastersVisible;
                        existing.customData = customData;
                        return;
                    }
                    const entity = viewer.entities.add({
                        name: ev.title,
                        position: Cesium.Cartesian3.fromDegrees(ev.longitude, ev.latitude, 5000),
                        show: disastersVisible,
                        billboard: {
                            image: img, scale: 0.6,
                            scaleByDistance: new Cesium.NearFarScalar(1e5, 0.9, 2e7, 0.35),
                            disableDepthTestDistance: 0
                        }
                    });
                    entity.customData = customData;
                    eonetEntities.set(ev.id, entity);
                });
                eonetEntities.forEach((ent, id) => {
                    if (!seen.has(id)) { viewer.entities.remove(ent); eonetEntities.delete(id); }
                });
                if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
                console.log(`[EONET] Rendered ${seen.size} natural events`);
            } catch (error) {
                console.error('[EONET] Load error:', error);
            }
        }

        function toggleDisasters() {
            disastersVisible = !disastersVisible;
            const btn = document.getElementById('btn-disasters');
            if (btn) btn.style.background = disastersVisible ? 'var(--accent)' : '';
            if (disastersVisible && !disastersLoaded) {
                disastersLoaded = true;
                loadGDACS();
                loadEONET();
            } else {
                disasterEntities.forEach(e => e.show = disastersVisible);
                eonetEntities.forEach(e => e.show = disastersVisible);
                if (viewer.scene.requestRenderMode) viewer.scene.requestRender();
            }
        }
        // Keep the disaster layers fresh while shown
        setInterval(() => { if (disastersVisible) { loadGDACS(); loadEONET(); } }, 10 * 60 * 1000);

        function updateNews() {
            const articles = state.news?.articles || [];
            document.getElementById('news-badge').textContent = articles.length;
            
            document.getElementById('news-list').innerHTML = articles.slice(0, 20).map(n => {
                const isHighRelevance = n.relevance >= 7;
                const platformClass = n.platform || n.category;
                
                return `
                <a href="${n.link}" target="_blank" rel="noopener" 
                   class="news-item ${isHighRelevance ? 'relevance-high' : ''}">
                    <div class="news-title">${n.icon || '📰'} ${n.title}</div>
                    <div class="news-meta">
                        <span class="news-platform ${platformClass}">${n.platform === 'youtube' ? '▶ VIDEO' : n.platform === 'reddit' ? '🔴 REDDIT' : n.category?.toUpperCase()}</span>
                        <span>${n.source}</span>
                        <span>Score: ${n.relevance}</span>
                    </div>
                </a>
            `}).join('') || 'No news';
        }
        
        function updateAlerts() {
            const alerts = state.alerts || [];
            document.getElementById('alerts-badge').textContent = alerts.length;
            document.getElementById('alerts-badge').className = 'badge badge-' + (
                alerts.some(a => a.severity === 'CRITICAL') ? 'critical' : alerts.length > 0 ? 'warning' : 'normal'
            );
            
            document.getElementById('alerts-list').innerHTML = alerts.slice(0, 6).map(a => `
                <div class="list-item" style="border-left-color: ${a.severity === 'CRITICAL' ? 'var(--critical)' : 'var(--warning)'}">
                    <span style="font-size: 0.75rem">[${a.source}] ${a.message?.substring(0, 60)}...</span>
                </div>
            `).join('') || 'No alerts';
        }
        
        function updateAI() {
            const ai = state.aiAnalysis || {};
            const badge = document.getElementById('ai-badge');
            badge.textContent = ai.threatLevel || 'PENDING';
            badge.className = 'badge badge-' + (ai.threatLevel === 'CRITICAL' ? 'critical' : ai.threatLevel === 'HIGH' ? 'danger' : 'normal');
            
            document.getElementById('ai-assessment').textContent = 
                ai.situationAssessment?.substring(0, 250) || 'Waiting for Ollama analysis...';
        }
        
        function updateThreat() {
            let score = 0;

            // GPS jamming zones
            const gpsZones = state.signals?.gpsJammingZones?.length || 0;
            if (gpsZones >= 5) score += 3; else if (gpsZones > 0) score += 1;

            // Critical alerts (the global feed already includes disasters/cyber/weather)
            const criticalAlerts = (state.alerts || []).filter(a => a.severity === 'CRITICAL').length;
            score += Math.min(criticalAlerts * 2, 6);

            // Signals module overall threat level
            const sigLevel = state.signals?.summary?.threatLevel || state.signals?.threatLevel;
            score += sigLevel === 'CRITICAL' ? 3 : sigLevel === 'HIGH' ? 2 : sigLevel === 'ELEVATED' ? 1 : 0;

            // Strategic/military flights by threat level (capped)
            const flights = state.flights?.flights || [];
            const critFlights = flights.filter(f => f.threatLevel === 'CRITICAL').length;
            const highFlights = flights.filter(f => f.threatLevel === 'HIGH').length;
            score += Math.min(critFlights * 2 + highFlights, 4);

            // Significant seismic activity (M ≥ 6.5)
            const bigQuakes = (state.seismic?.events || []).filter(e => (e.magnitude || 0) >= 6.5).length;
            score += Math.min(bigQuakes, 2);

            // Red (critical) GDACS disasters
            const redDisasters = state['gdacs-monitor']?.summary?.byAlert?.Red || 0;
            score += Math.min(redDisasters, 2);

            // Pentagon Pizza Index
            const pizza = state.pizzaIndex?.alertLevel;
            score += pizza === 'CRITICAL' ? 2 : pizza === 'ELEVATED' ? 1 : 0;

            // Thresholds tuned for the wider input set (avoid over-reacting to a
            // couple of routine HIGH flights — those alone stay NORMAL).
            let level, desc, className;
            if (score >= 10) {
                level = 'CRITICAL'; desc = 'ACTION IMMINENT'; className = 'critical';
            } else if (score >= 6) {
                level = 'HIGH'; desc = 'ELEVATED ACTIVITY'; className = 'danger';
            } else if (score >= 4) {
                level = 'ELEVATED'; desc = 'MONITORING'; className = 'warning';
            } else {
                level = 'NORMAL'; desc = 'ROUTINE OPS'; className = 'normal';
            }
            
            document.getElementById('threat-level').textContent = level;
            document.getElementById('threat-level').className = 'metric-big ' + className;
            document.getElementById('threat-desc').textContent = desc;
        }
        
        setInterval(updateThreat, 30000);

        // ============================================
        // SATELLITE IMAGERY FUNCTIONALITY
        // ============================================

        // Imagery providers cache
        let imageryProviders = {};
        let currentImageryLayer = null;
        let comparisonLayer = null;
        let contextMenuLat = 0;
        let contextMenuLon = 0;

        // Strategic zones for quick navigation
        const STRATEGIC_ZONES = {
            hormuz: { lat: 26.5, lon: 56.5, height: 500000, name: 'Strait of Hormuz' },
            ukraine: { lat: 48.5, lon: 37.5, height: 800000, name: 'Ukraine Frontlines' },
            taiwan: { lat: 24.0, lon: 119.5, height: 600000, name: 'Taiwan Strait' },
            redsea: { lat: 13.0, lon: 43.0, height: 800000, name: 'Red Sea' },
            iran: { lat: 33.0, lon: 52.0, height: 1000000, name: 'Iran' },
            dprk: { lat: 39.5, lon: 126.0, height: 600000, name: 'North Korea' },
            kaliningrad: { lat: 54.7, lon: 20.5, height: 300000, name: 'Kaliningrad' }
        };

        // Initialize GIBS date to yesterday
        function initGIBSDate() {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split('T')[0];
            document.getElementById('gibs-date').value = dateStr;
            document.getElementById('gibs-date').max = dateStr;

            // Set min date to 2012 (GIBS archive start)
            document.getElementById('gibs-date').min = '2012-05-08';
        }
        initGIBSDate();

        // Toggle imagery panel collapse
        function toggleImageryPanel() {
            const panel = document.getElementById('imagery-panel');
            const toggle = document.getElementById('imagery-toggle');
            panel.classList.toggle('collapsed');
            toggle.textContent = panel.classList.contains('collapsed') ? '+' : '-';
        }

        // Create imagery provider based on source
        function createImageryProvider(source, date = null) {
            const gibsDate = date || document.getElementById('gibs-date').value;

            switch (source) {
                case 'esri':
                    // Use UrlTemplateImageryProvider for better compatibility
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
                        maximumLevel: 19,
                        credit: 'ESRI World Imagery'
                    });

                case 'osm':
                    return new Cesium.OpenStreetMapImageryProvider({
                        url: 'https://tile.openstreetmap.org/'
                    });

                case 'gibs_modis':
                    // NASA GIBS using UrlTemplateImageryProvider for proper alignment
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/' + gibsDate + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
                        maximumLevel: 9,
                        credit: 'NASA GIBS - MODIS Terra ' + gibsDate
                    });

                case 'gibs_viirs':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + gibsDate + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
                        maximumLevel: 9,
                        credit: 'NASA GIBS - VIIRS SNPP ' + gibsDate
                    });

                case 'gibs_bluemarble':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/EPSG3857_500m/{z}/{y}/{x}.jpeg',
                        maximumLevel: 8,
                        credit: 'NASA Blue Marble Next Generation'
                    });

                case 'gibs_nightlights':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
                        maximumLevel: 8,
                        credit: 'NASA Black Marble Night Lights'
                    });

                case 'carto_dark':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
                        maximumLevel: 19,
                        credit: 'CartoDB Dark Matter'
                    });

                case 'carto_voyager_dark':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
                        maximumLevel: 19,
                        credit: 'CartoDB Voyager Dark'
                    });

                case 'esri_dark_gray':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
                        maximumLevel: 16,
                        credit: 'ESRI Dark Gray Canvas'
                    });

                case 'carto_light':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                        maximumLevel: 19,
                        credit: 'CartoDB Positron'
                    });

                case 'stamen_toner':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://tiles.stadiamaps.com/tiles/stamen_toner/{z}/{x}/{y}.png',
                        maximumLevel: 18,
                        credit: 'Stadia Maps / Stamen Toner'
                    });

                case 'stamen_terrain':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}.png',
                        maximumLevel: 18,
                        credit: 'Stadia Maps / Stamen Terrain'
                    });

                case 'opentopomap':
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png',
                        maximumLevel: 17,
                        credit: 'OpenTopoMap'
                    });

                default:
                    return new Cesium.UrlTemplateImageryProvider({
                        url: 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
                        maximumLevel: 19,
                        credit: 'CartoDB Dark Matter'
                    });
            }
        }

        // Change imagery source
        function changeImagerySource() {
            const source = document.getElementById('imagery-source').value;
            const gibsDateRow = document.getElementById('gibs-date-row');

            // Show/hide GIBS date selector
            if (source.startsWith('gibs')) {
                gibsDateRow.style.display = 'block';
            } else {
                gibsDateRow.style.display = 'none';
            }

            // Remember if overlay was enabled
            const overlayWasEnabled = nasaOverlayLayer !== null;

            // Remove all existing imagery layers (including overlay)
            viewer.imageryLayers.removeAll();
            nasaOverlayLayer = null;

            // Add new imagery provider
            try {
                const provider = createImageryProvider(source);
                currentImageryLayer = viewer.imageryLayers.addImageryProvider(provider);

                // Update status
                const sourceNames = {
                    'carto_dark': 'CartoDB Dark',
                    'carto_voyager_dark': 'CartoDB Voyager Dark',
                    'esri_dark_gray': 'ESRI Dark Gray',
                    'esri': 'ESRI Satellite',
                    'osm': 'OpenStreetMap',
                    'carto_light': 'CartoDB Light',
                    'stamen_toner': 'Stamen Toner',
                    'stamen_terrain': 'Stamen Terrain',
                    'opentopomap': 'OpenTopoMap',
                    'gibs_modis': 'NASA GIBS (MODIS)',
                    'gibs_viirs': 'NASA GIBS (VIIRS)',
                    'gibs_bluemarble': 'NASA Blue Marble',
                    'gibs_nightlights': 'NASA Night Lights'
                };
                document.getElementById('current-source').textContent = sourceNames[source] || source;

                console.log('[IMAGERY] Switched to:', source);

                // Re-add overlay if it was enabled
                if (overlayWasEnabled) {
                    addNASAOverlay();
                }
            } catch (error) {
                console.error('[IMAGERY] Error switching source:', error);
                // Fallback to OSM
                viewer.imageryLayers.addImageryProvider(
                    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' })
                );
            }
        }

        // Change GIBS date
        function changeGIBSDate() {
            const source = document.getElementById('imagery-source').value;
            if (source.startsWith('gibs')) {
                changeImagerySource();
            }
        }

        // Change layer opacity
        function changeOpacity() {
            const opacity = document.getElementById('opacity-slider').value / 100;
            if (currentImageryLayer) {
                currentImageryLayer.alpha = opacity;
            }
        }

        // NASA Cloud Overlay Layer
        let nasaOverlayLayer = null;

        // Toggle NASA weather/cloud overlay
        function toggleNASAOverlay() {
            const enabled = document.getElementById('nasa-overlay-toggle').checked;
            const opacityRow = document.getElementById('nasa-overlay-opacity-row');

            if (enabled) {
                opacityRow.style.display = 'block';
                addNASAOverlay();
            } else {
                opacityRow.style.display = 'none';
                removeNASAOverlay();
            }
        }

        // Add NASA GIBS cloud/weather overlay
        function addNASAOverlay() {
            // Remove existing overlay
            removeNASAOverlay();

            // Get yesterday's date for GIBS (data has 1-day latency)
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const gibsDate = yesterday.toISOString().split('T')[0];

            try {
                // Use VIIRS corrected reflectance for cloud visibility
                const overlayProvider = new Cesium.UrlTemplateImageryProvider({
                    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/' + gibsDate + '/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
                    maximumLevel: 9,
                    credit: 'NASA GIBS Weather Overlay'
                });

                nasaOverlayLayer = viewer.imageryLayers.addImageryProvider(overlayProvider);

                // Set initial opacity
                const opacity = document.getElementById('nasa-overlay-opacity').value / 100;
                nasaOverlayLayer.alpha = opacity;

                // Move to top of layer stack
                viewer.imageryLayers.raiseToTop(nasaOverlayLayer);

                console.log('[OVERLAY] NASA cloud overlay enabled');
            } catch (error) {
                console.error('[OVERLAY] Error adding NASA overlay:', error);
            }
        }

        // Remove NASA overlay
        function removeNASAOverlay() {
            if (nasaOverlayLayer) {
                viewer.imageryLayers.remove(nasaOverlayLayer);
                nasaOverlayLayer = null;
                console.log('[OVERLAY] NASA cloud overlay disabled');
            }
        }

        // Change NASA overlay opacity
        function changeNASAOverlayOpacity() {
            const opacity = document.getElementById('nasa-overlay-opacity').value / 100;
            if (nasaOverlayLayer) {
                nasaOverlayLayer.alpha = opacity;
            }
        }

        // ========== SUN/MOON DAY/NIGHT SIMULATION ==========
        let sunEntity = null;
        let moonEntity = null;
        let dayNightEnabled = false;

        function toggleDayNight() {
            const enabled = document.getElementById('daynight-toggle').checked;
            dayNightEnabled = enabled;

            if (enabled) {
                // Enable lighting (day/night terminator)
                viewer.scene.globe.enableLighting = true;
                viewer.scene.sun.show = true;
                viewer.scene.moon.show = true;

                // Clock-driven lighting needs continuous rendering → leave render-on-demand
                viewer.scene.requestRenderMode = false;

                // Enable real-time clock
                viewer.clock.shouldAnimate = true;
                viewer.clock.multiplier = 1; // Real-time
                viewer.clock.currentTime = Cesium.JulianDate.now();

                // Add sun position marker
                addSunMarker();
                addMoonMarker();

                console.log('[DAYNIGHT] Sun/Moon simulation enabled');
            } else {
                // Disable lighting
                viewer.scene.globe.enableLighting = false;

                // Back to render-on-demand (clock no longer drives the scene)
                viewer.clock.shouldAnimate = false;
                viewer.scene.requestRenderMode = true;
                viewer.scene.requestRender();

                // Remove markers
                if (sunEntity) {
                    viewer.entities.remove(sunEntity);
                    sunEntity = null;
                }
                if (moonEntity) {
                    viewer.entities.remove(moonEntity);
                    moonEntity = null;
                }

                console.log('[DAYNIGHT] Sun/Moon simulation disabled');
            }
        }

        function addSunMarker() {
            if (sunEntity) viewer.entities.remove(sunEntity);

            sunEntity = viewer.entities.add({
                id: 'sun-marker',
                position: new Cesium.CallbackProperty(() => {
                    const sunPos = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(viewer.clock.currentTime);
                    return Cesium.Transforms.computeIcrfToFixedMatrix(viewer.clock.currentTime) ?
                        Cesium.Matrix3.multiplyByVector(
                            Cesium.Transforms.computeIcrfToFixedMatrix(viewer.clock.currentTime),
                            sunPos, new Cesium.Cartesian3()
                        ) : sunPos;
                }, false),
                point: {
                    pixelSize: 25,
                    color: Cesium.Color.YELLOW,
                    outlineColor: Cesium.Color.ORANGE,
                    outlineWidth: 1,
                    disableDepthTestDistance: 0
                },
                label: {
                    text: '☀️ SUN',
                    font: '12px JetBrains Mono',
                    fillColor: Cesium.Color.YELLOW,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -15),
                    disableDepthTestDistance: 0
                }
            });
        }

        function addMoonMarker() {
            if (moonEntity) viewer.entities.remove(moonEntity);

            moonEntity = viewer.entities.add({
                id: 'moon-marker',
                position: new Cesium.CallbackProperty(() => {
                    const moonPos = Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(viewer.clock.currentTime);
                    return Cesium.Transforms.computeIcrfToFixedMatrix(viewer.clock.currentTime) ?
                        Cesium.Matrix3.multiplyByVector(
                            Cesium.Transforms.computeIcrfToFixedMatrix(viewer.clock.currentTime),
                            moonPos, new Cesium.Cartesian3()
                        ) : moonPos;
                }, false),
                point: {
                    pixelSize: 18,
                    color: Cesium.Color.LIGHTGRAY,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 1,
                    disableDepthTestDistance: 0
                },
                label: {
                    text: '🌙 MOON',
                    font: '11px JetBrains Mono',
                    fillColor: Cesium.Color.LIGHTGRAY,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                    pixelOffset: new Cesium.Cartesian2(0, -12),
                    disableDepthTestDistance: 0
                }
            });
        }

        // Get subsolar point (where sun is directly overhead)
        function getSubsolarPoint() {
            const now = new Date();
            const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
            const hour = now.getUTCHours() + now.getUTCMinutes() / 60;

            // Solar declination (approximate)
            const declination = -23.45 * Math.cos(2 * Math.PI * (dayOfYear + 10) / 365);

            // Hour angle - sun is overhead at 12:00 UTC at 0° longitude
            const hourAngle = (12 - hour) * 15;

            return { lat: declination, lon: hourAngle };
        }

        // ========== TIME ZONE BORDERS ==========
        let timeZoneEntities = [];
        let timeZonesEnabled = false;

        function toggleTimeZones() {
            const enabled = document.getElementById('timezone-toggle').checked;
            timeZonesEnabled = enabled;

            if (enabled) {
                addTimeZoneBorders();
                console.log('[TIMEZONE] Time zone borders enabled');
            } else {
                removeTimeZoneBorders();
                console.log('[TIMEZONE] Time zone borders disabled');
            }
        }

        function addTimeZoneBorders() {
            removeTimeZoneBorders();

            // Draw lines every 15 degrees longitude (1 hour = 15°)
            for (let tz = -12; tz <= 12; tz++) {
                const lon = tz * 15;
                const utcOffset = tz >= 0 ? `+${tz}` : `${tz}`;

                // Timezone line (from pole to pole)
                const lineEntity = viewer.entities.add({
                    id: `timezone-line-${tz}`,
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray([
                            lon, -85,
                            lon, 85
                        ]),
                        width: tz === 0 ? 3 : 1.5,
                        material: tz === 0 ?
                            new Cesium.PolylineDashMaterialProperty({
                                color: Cesium.Color.RED.withAlpha(0.8),
                                dashLength: 16
                            }) :
                            new Cesium.PolylineDashMaterialProperty({
                                color: Cesium.Color.CYAN.withAlpha(0.4),
                                dashLength: 8
                            }),
                        clampToGround: false
                    }
                });
                timeZoneEntities.push(lineEntity);

                // UTC label at equator
                const labelEntity = viewer.entities.add({
                    id: `timezone-label-${tz}`,
                    position: Cesium.Cartesian3.fromDegrees(lon, 0, 50000),
                    label: {
                        text: `UTC${utcOffset}`,
                        font: '10px JetBrains Mono',
                        fillColor: tz === 0 ? Cesium.Color.RED : Cesium.Color.CYAN,
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                        verticalOrigin: Cesium.VerticalOrigin.CENTER,
                        scale: 0.9,
                        disableDepthTestDistance: 0,
                        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.5, 1e8, 0.5)
                    }
                });
                timeZoneEntities.push(labelEntity);
            }

            // Highlight Prime Meridian and International Date Line
            const dateLineEntity = viewer.entities.add({
                id: 'dateline',
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArray([180, -85, 180, 85]),
                    width: 3,
                    material: new Cesium.PolylineDashMaterialProperty({
                        color: Cesium.Color.MAGENTA.withAlpha(0.7),
                        dashLength: 16
                    }),
                    clampToGround: false
                }
            });
            timeZoneEntities.push(dateLineEntity);

            const dateLineLabelEntity = viewer.entities.add({
                id: 'dateline-label',
                position: Cesium.Cartesian3.fromDegrees(180, 0, 50000),
                label: {
                    text: 'DATE LINE',
                    font: '600 11px JetBrains Mono',
                    fillColor: Cesium.Color.MAGENTA,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                    disableDepthTestDistance: 0
                }
            });
            timeZoneEntities.push(dateLineLabelEntity);
        }

        function removeTimeZoneBorders() {
            timeZoneEntities.forEach(e => viewer.entities.remove(e));
            timeZoneEntities = [];
        }

        // ========== EQUATOR TIME DISPLAY ==========
        let equatorTimeEntities = [];
        let equatorTimeEnabled = false;
        let equatorTimeInterval = null;

        function toggleEquatorTime() {
            const enabled = document.getElementById('equator-time-toggle').checked;
            equatorTimeEnabled = enabled;

            if (enabled) {
                addEquatorTimeDisplay();
                // Update every second
                equatorTimeInterval = setInterval(updateEquatorTime, 1000);
                console.log('[EQUATOR] Equator time display enabled');
            } else {
                removeEquatorTimeDisplay();
                if (equatorTimeInterval) {
                    clearInterval(equatorTimeInterval);
                    equatorTimeInterval = null;
                }
                console.log('[EQUATOR] Equator time display disabled');
            }
        }

        function addEquatorTimeDisplay() {
            removeEquatorTimeDisplay();

            // Add equator line
            const equatorLine = viewer.entities.add({
                id: 'equator-line',
                polyline: {
                    positions: Cesium.Cartesian3.fromDegreesArray([
                        -180, 0, -120, 0, -60, 0, 0, 0, 60, 0, 120, 0, 180, 0
                    ]),
                    width: 2,
                    material: Cesium.Color.fromCssColorString('#00ff9d').withAlpha(0.5),
                    clampToGround: false
                }
            });
            equatorTimeEntities.push(equatorLine);

            // Add time markers every 30 degrees (2 hours)
            for (let lon = -180; lon < 180; lon += 30) {
                const tzOffset = Math.round(lon / 15);
                const markerId = `equator-time-${lon}`;

                const marker = viewer.entities.add({
                    id: markerId,
                    position: Cesium.Cartesian3.fromDegrees(lon, 0, 30000),
                    label: {
                        text: getLocalTimeAtLongitude(lon),
                        font: '600 12px JetBrains Mono',
                        fillColor: Cesium.Color.fromCssColorString('#00ff9d'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
                        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                        disableDepthTestDistance: 0,
                        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.2, 5e7, 0.6)
                    },
                    point: {
                        pixelSize: 8,
                        color: Cesium.Color.fromCssColorString('#00ff9d'),
                        outlineColor: Cesium.Color.BLACK,
                        outlineWidth: 1,
                        disableDepthTestDistance: 0
                    }
                });
                equatorTimeEntities.push(marker);
            }
        }

        function getLocalTimeAtLongitude(longitude) {
            const now = new Date();
            const utcHours = now.getUTCHours();
            const utcMinutes = now.getUTCMinutes();

            // Calculate offset (15° = 1 hour)
            const offsetHours = longitude / 15;
            let localHours = utcHours + offsetHours;

            // Normalize to 0-24
            while (localHours < 0) localHours += 24;
            while (localHours >= 24) localHours -= 24;

            const hours = Math.floor(localHours);
            const minutes = utcMinutes;

            // Format time
            const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

            // Determine day/night emoji
            const isDaytime = hours >= 6 && hours < 18;
            const emoji = isDaytime ? '☀️' : '🌙';

            return `${emoji} ${timeStr}`;
        }

        function updateEquatorTime() {
            if (!equatorTimeEnabled) return;

            for (let lon = -180; lon < 180; lon += 30) {
                const markerId = `equator-time-${lon}`;
                const entity = viewer.entities.getById(markerId);
                if (entity && entity.label) {
                    entity.label.text = getLocalTimeAtLongitude(lon);
                }
            }
        }

        function removeEquatorTimeDisplay() {
            equatorTimeEntities.forEach(e => viewer.entities.remove(e));
            equatorTimeEntities = [];
        }

        // Fly to strategic zone
        function flyToZone() {
            const zoneId = document.getElementById('zone-select').value;
            if (!zoneId || !STRATEGIC_ZONES[zoneId]) return;

            const zone = STRATEGIC_ZONES[zoneId];
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(zone.lon, zone.lat, zone.height),
                duration: 2,
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-60),
                    roll: 0
                }
            });

            console.log('[IMAGERY] Flying to zone:', zone.name);
        }

        // Open NASA Worldview
        function openNASAWorldview() {
            const center = viewer.camera.positionCartographic;
            const lat = Cesium.Math.toDegrees(center.latitude);
            const lon = Cesium.Math.toDegrees(center.longitude);
            const date = document.getElementById('gibs-date').value;
            const offset = 3;
            const url = `https://worldview.earthdata.nasa.gov/?v=${lon - offset},${lat - offset},${lon + offset},${lat + offset}&t=${date}`;
            window.open(url, '_blank');
        }

        // Open Wayback history viewer
        function openWaybackHistory() {
            const center = viewer.camera.positionCartographic;
            const lat = Cesium.Math.toDegrees(center.latitude);
            const lon = Cesium.Math.toDegrees(center.longitude);
            // ESRI Wayback viewer
            const url = `https://livingatlas.arcgis.com/wayback/?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=14`;
            window.open(url, '_blank');
        }

        // ============================================
        // RIGHT-CLICK CONTEXT MENU
        // ============================================

        const contextMenu = document.getElementById('context-menu');

        // Right-click handler
        handler.setInputAction(function(click) {
            const cartesian = viewer.camera.pickEllipsoid(click.position, viewer.scene.globe.ellipsoid);

            if (cartesian) {
                const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
                contextMenuLat = Cesium.Math.toDegrees(cartographic.latitude);
                contextMenuLon = Cesium.Math.toDegrees(cartographic.longitude);

                // Update coordinates display
                document.getElementById('context-coords').textContent =
                    `${contextMenuLat.toFixed(4)}, ${contextMenuLon.toFixed(4)}`;

                // Position menu
                contextMenu.style.left = click.position.x + 'px';
                contextMenu.style.top = click.position.y + 'px';
                contextMenu.classList.add('visible');
            }
        }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

        // Close context menu on left click
        document.addEventListener('click', function(e) {
            if (!contextMenu.contains(e.target)) {
                contextMenu.classList.remove('visible');
            }
        });

        // Open NASA Worldview at right-clicked location
        function openNASAWorldviewAt() {
            const date = document.getElementById('gibs-date').value;
            const offset = 2;
            const url = `https://worldview.earthdata.nasa.gov/?v=${contextMenuLon - offset},${contextMenuLat - offset},${contextMenuLon + offset},${contextMenuLat + offset}&t=${date}`;
            window.open(url, '_blank');
            contextMenu.classList.remove('visible');
        }

        // Open Sentinel Hub EO Browser
        function openSentinelHub() {
            const url = `https://apps.sentinel-hub.com/eo-browser/?lat=${contextMenuLat.toFixed(4)}&lng=${contextMenuLon.toFixed(4)}&zoom=12`;
            window.open(url, '_blank');
            contextMenu.classList.remove('visible');
        }

        // Open Google Earth Web
        function openGoogleEarthWeb() {
            const url = `https://earth.google.com/web/@${contextMenuLat.toFixed(6)},${contextMenuLon.toFixed(6)},1000a,1000d,35y,0h,0t,0r`;
            window.open(url, '_blank');
            contextMenu.classList.remove('visible');
        }

        // Open Copernicus Browser
        function openCopernicus() {
            const url = `https://browser.dataspace.copernicus.eu/?lat=${contextMenuLat.toFixed(4)}&lng=${contextMenuLon.toFixed(4)}&zoom=12`;
            window.open(url, '_blank');
            contextMenu.classList.remove('visible');
        }

        // Check ESRI Wayback at location
        function checkWaybackAt() {
            const url = `https://livingatlas.arcgis.com/wayback/?lat=${contextMenuLat.toFixed(4)}&lon=${contextMenuLon.toFixed(4)}&zoom=15`;
            window.open(url, '_blank');
            contextMenu.classList.remove('visible');
        }

        // Copy coordinates to clipboard
        function copyCoordinates() {
            const coords = `${contextMenuLat.toFixed(6)}, ${contextMenuLon.toFixed(6)}`;
            navigator.clipboard.writeText(coords).then(() => {
                console.log('[IMAGERY] Coordinates copied:', coords);
            });
            contextMenu.classList.remove('visible');
        }

        // ============================================
        // COMPARISON SLIDER
        // ============================================

        function updateCompare() {
            const value = document.getElementById('compare-slider').value / 100;
            if (comparisonLayer) {
                comparisonLayer.alpha = value;
            }
        }

        function closeCompare() {
            document.getElementById('compare-overlay').classList.remove('visible');
            if (comparisonLayer) {
                viewer.imageryLayers.remove(comparisonLayer);
                comparisonLayer = null;
            }
        }

        // ============================================
        // SOCKET.IO SATELLITE UPDATES
        // ============================================

        socket.on('satellite-update', (data) => {
            state.satellite = data;
            console.log('[SATELLITE] Update received:', data.status);
        });

        // Fetch satellite layers on startup
        async function initSatelliteLayers() {
            try {
                const response = await fetch('/api/satellite/layers');
                const layers = await response.json();
                console.log('[SATELLITE] Available layers:', layers.providers?.length || 0);
            } catch (error) {
                console.error('[SATELLITE] Error fetching layers:', error);
            }
        }
        initSatelliteLayers();

        console.log('[SATELLITE] Imagery controls initialized');

        // ============================================
        // MODAL SYSTEM FOR DETAILED VIEWS
        // ============================================

        function openModal(type) {
            const overlay = document.getElementById('modal-overlay');
            const title = document.getElementById('modal-title');
            const body = document.getElementById('modal-body');

            let content = '';

            switch (type) {
                case 'seismic':
                    title.textContent = '🌍 SEISMIC EVENTS (24H)';
                    const quakes = (state.seismic?.events || []).sort((a, b) => b.magnitude - a.magnitude);
                    content = quakes.length ? quakes.map(q => {
                        const severity = q.magnitude >= 6 ? 'critical' : q.magnitude >= 5 ? 'high' : q.magnitude >= 4 ? 'medium' : '';
                        const time = new Date(q.time).toLocaleString();
                        return `
                            <div class="modal-item ${severity}" onclick="flyToLocation(${q.longitude}, ${q.latitude}, 500000)">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">${q.place || 'Unknown Location'}</div>
                                    <div class="modal-item-meta">${time} | Depth: ${q.depth?.toFixed(1) || '?'} km</div>
                                </div>
                                <span class="modal-item-badge mag">M${q.magnitude?.toFixed(1)}</span>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(${q.longitude}, ${q.latitude}, 300000)">📍 GO</button>
                            </div>
                        `;
                    }).join('') : '<p style="color: var(--text-dim)">No seismic events detected</p>';
                    break;

                case 'gps':
                    title.textContent = '📡 GPS INTERFERENCE ZONES';
                    const zones = state.signals?.gpsJammingZones || [];
                    content = zones.length ? zones.map(z => `
                        <div class="modal-item medium" onclick="flyToLocation(${z.longitude}, ${z.latitude}, 1000000)">
                            <div class="modal-item-main">
                                <div class="modal-item-title">GPS Jamming Zone</div>
                                <div class="modal-item-meta">Lat: ${z.latitude?.toFixed(2)} | Lon: ${z.longitude?.toFixed(2)} | Source: ${z.source || 'Unknown'}</div>
                            </div>
                            <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(${z.longitude}, ${z.latitude}, 500000)">📍 GO</button>
                        </div>
                    `).join('') : '<p style="color: var(--text-dim)">No GPS interference detected</p>';

                    // Add known jamming regions
                    content += `
                        <div style="margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--border);">
                            <div style="font-size: 0.75rem; color: var(--text-dim); margin-bottom: 10px;">KNOWN JAMMING REGIONS:</div>
                            <div class="modal-item" onclick="flyToLocation(21, 54.7, 800000)">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">Kaliningrad Region</div>
                                    <div class="modal-item-meta">Russia - Persistent GPS/GNSS jamming</div>
                                </div>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(21, 54.7, 400000)">📍 GO</button>
                            </div>
                            <div class="modal-item" onclick="flyToLocation(20, 57, 1500000)">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">Baltic Sea Region</div>
                                    <div class="modal-item-meta">Widespread interference affecting aviation</div>
                                </div>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(20, 57, 800000)">📍 GO</button>
                            </div>
                            <div class="modal-item" onclick="flyToLocation(37, 35, 1000000)">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">Eastern Mediterranean</div>
                                    <div class="modal-item-meta">Syria/Lebanon border region</div>
                                </div>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(37, 35, 500000)">📍 GO</button>
                            </div>
                        </div>
                    `;
                    break;

                case 'flights':
                    title.textContent = '✈️ MILITARY AIR OPERATIONS';
                    const flights = (state.flights?.flights || []).sort((a, b) => {
                        const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
                        return (order[a.threatLevel] || 4) - (order[b.threatLevel] || 4);
                    });

                    // Summary by category
                    const summary = state.flights?.summary || {};
                    const catCounts = summary.byCategory || {};
                    const threatCounts = summary.byThreatLevel || {};

                    const getFlightIcon = (cat) => {
                        switch(cat) {
                            case 'bombers':
                            case 'stealth-bomber': return '💣';
                            case 'tankers': return '⛽';
                            case 'surveillance': return '👁';
                            case 'transport': return '📦';
                            case 'specialOps': return '🎯';
                            case 'uav': return '🛸';
                            case 'fighter': return '⚔️';
                            case 'electronicWarfare': return '📡';
                            default: return '✈️';
                        }
                    };

                    content = `
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid var(--border);">
                            <div style="text-align: center; padding: 8px; background: rgba(255,0,64,0.2); border-radius: 4px;">
                                <div style="font-size: 1.2rem; color: #ff0040; font-weight: bold;">${threatCounts.CRITICAL || 0}</div>
                                <div style="font-size: 0.6rem; color: #888;">CRITICAL</div>
                            </div>
                            <div style="text-align: center; padding: 8px; background: rgba(255,160,0,0.2); border-radius: 4px;">
                                <div style="font-size: 1.2rem; color: orange; font-weight: bold;">${threatCounts.HIGH || 0}</div>
                                <div style="font-size: 0.6rem; color: #888;">HIGH</div>
                            </div>
                            <div style="text-align: center; padding: 8px; background: rgba(255,255,0,0.15); border-radius: 4px;">
                                <div style="font-size: 1.2rem; color: yellow; font-weight: bold;">${threatCounts.MEDIUM || 0}</div>
                                <div style="font-size: 0.6rem; color: #888;">MEDIUM</div>
                            </div>
                            <div style="text-align: center; padding: 8px; background: rgba(0,200,255,0.15); border-radius: 4px;">
                                <div style="font-size: 1.2rem; color: cyan; font-weight: bold;">${threatCounts.LOW || 0}</div>
                                <div style="font-size: 0.6rem; color: #888;">LOW</div>
                            </div>
                        </div>
                        <div style="font-size: 0.7rem; color: var(--accent); margin-bottom: 8px; font-family: var(--font-display);">FLEET COMPOSITION:</div>
                        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid var(--border);">
                            ${Object.entries(catCounts).map(([cat, count]) => `
                                <span style="background: rgba(0,200,255,0.1); padding: 3px 8px; border-radius: 3px; font-size: 0.65rem;">
                                    ${getFlightIcon(cat)} ${cat}: ${count}
                                </span>
                            `).join('')}
                        </div>
                        <div style="font-size: 0.7rem; color: var(--accent); margin-bottom: 8px; font-family: var(--font-display);">TRACKED AIRCRAFT (${flights.length}):</div>
                    `;

                    content += flights.length ? flights.slice(0, 50).map(f => {
                        const severity = f.threatLevel === 'CRITICAL' ? 'critical' : f.threatLevel === 'HIGH' ? 'high' : '';
                        const regionStr = f.region?.name || f.region || '';
                        return `
                            <div class="modal-item ${severity}" onclick="flyToLocation(${f.longitude}, ${f.latitude}, 200000)">
                                <div style="font-size: 1rem; margin-right: 8px;">${getFlightIcon(f.category)}</div>
                                <div class="modal-item-main">
                                    <div class="modal-item-title">${f.callsign || f.icao24 || 'Unknown'} <span style="font-size: 0.65rem; color: #888; font-weight: normal;">${f.aircraftType || ''}</span></div>
                                    <div class="modal-item-meta">
                                        Alt: ${f.altitude ? Math.round(f.altitude).toLocaleString() + 'ft' : '?'} |
                                        Speed: ${f.velocity ? Math.round(f.velocity) + 'kts' : '?'} |
                                        Hdg: ${f.heading ? Math.round(f.heading) + '°' : '?'}
                                        ${regionStr ? '| <span style="color: var(--accent);">' + regionStr + '</span>' : ''}
                                    </div>
                                </div>
                                <span class="modal-item-badge ${f.threatLevel === 'CRITICAL' ? 'critical' : f.threatLevel === 'HIGH' ? 'high' : ''}">${f.threatLevel || 'LOW'}</span>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(${f.longitude}, ${f.latitude}, 100000)">📍 GO</button>
                            </div>
                        `;
                    }).join('') : '<p style="color: var(--text-dim)">No flights tracked</p>';
                    break;

                case 'weather':
                    title.textContent = '🌡️ WEATHER STATIONS';
                    const locations = state.weather?.locations || [];
                    content = locations.map(loc => {
                        const w = loc.weather?.current;
                        if (!w) return '';
                        return `
                            <div class="modal-item" onclick="flyToLocation(${loc.lon}, ${loc.lat}, 500000)">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">${loc.name}</div>
                                    <div class="modal-item-meta">${w.weatherDescription || 'N/A'} | Wind: ${w.windSpeed?.toFixed(1) || '?'} km/h | Humidity: ${w.humidity || '?'}%</div>
                                </div>
                                <span class="modal-item-badge mag">${Math.round(w.temperature)}°C</span>
                                <button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(${loc.lon}, ${loc.lat}, 200000)">📍 GO</button>
                            </div>
                        `;
                    }).join('') || '<p style="color: var(--text-dim)">No weather data</p>';
                    break;

                case 'alerts':
                    title.textContent = '🚨 ACTIVE ALERTS';
                    const alerts = state.alerts || [];
                    content = alerts.length ? alerts.map(a => {
                        const severity = a.severity === 'CRITICAL' ? 'critical' : a.severity === 'HIGH' ? 'high' : '';
                        return `
                            <div class="modal-item ${severity}">
                                <div class="modal-item-main">
                                    <div class="modal-item-title">[${a.source}] ${a.message}</div>
                                    <div class="modal-item-meta">${new Date(a.timestamp).toLocaleString()}</div>
                                </div>
                                <span class="modal-item-badge ${severity}">${a.severity}</span>
                            </div>
                        `;
                    }).join('') : '<p style="color: var(--text-dim)">No active alerts</p>';
                    break;

                case 'news':
                    title.textContent = '📰 INTEL NEWS FEED';
                    const articles = state.news?.articles || [];
                    content = articles.slice(0, 50).map(n => {
                        const geo = inferLocationFromNews(n.title + ' ' + (n.snippet || ''));
                        const hasGeo = geo !== null;
                        const severity = n.relevance >= 9 ? 'critical' : n.relevance >= 7 ? 'high' : '';
                        return `
                            <div class="modal-item ${severity}" ${hasGeo ? `onclick="flyToLocation(${geo.lon}, ${geo.lat}, 2000000)"` : ''}>
                                <div class="modal-item-main">
                                    <div class="modal-item-title">${n.icon || '📰'} ${n.title}</div>
                                    <div class="modal-item-meta">
                                        ${n.source} | Score: ${n.relevance} | ${new Date(n.pubDate).toLocaleString()}
                                        ${hasGeo ? ` | 📍 ${geo.name}` : ''}
                                    </div>
                                </div>
                                ${hasGeo ? `<button class="geo-btn" onclick="event.stopPropagation(); flyToLocation(${geo.lon}, ${geo.lat}, 1000000)">📍 GO</button>` : ''}
                                <a href="${n.link}" target="_blank" class="geo-btn" onclick="event.stopPropagation()">🔗</a>
                            </div>
                        `;
                    }).join('') || '<p style="color: var(--text-dim)">No news articles</p>';
                    break;

                default:
                    content = '<p>No data available</p>';
            }

            body.innerHTML = content;
            overlay.classList.add('visible');
        }

        function closeModal(event) {
            if (event && event.target !== event.currentTarget) return;
            document.getElementById('modal-overlay').classList.remove('visible');
        }

        function flyToLocation(lon, lat, height = 500000) {
            closeModal();
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
                duration: 1.5,
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-60),
                    roll: 0
                }
            });
        }

        // Infer location from news text using keyword matching
        const LOCATION_KEYWORDS = {
            'ukraine': { name: 'Ukraine', lat: 48.5, lon: 31.5 },
            'kyiv': { name: 'Kyiv, Ukraine', lat: 50.45, lon: 30.52 },
            'kiev': { name: 'Kyiv, Ukraine', lat: 50.45, lon: 30.52 },
            'kharkiv': { name: 'Kharkiv, Ukraine', lat: 49.99, lon: 36.23 },
            'donbas': { name: 'Donbas, Ukraine', lat: 48.0, lon: 38.0 },
            'donetsk': { name: 'Donetsk, Ukraine', lat: 48.0, lon: 37.8 },
            'crimea': { name: 'Crimea', lat: 45.0, lon: 34.0 },
            'zaporizhzhia': { name: 'Zaporizhzhia, Ukraine', lat: 47.85, lon: 35.12 },
            'russia': { name: 'Russia', lat: 55.75, lon: 37.62 },
            'moscow': { name: 'Moscow, Russia', lat: 55.75, lon: 37.62 },
            'iran': { name: 'Iran', lat: 32.0, lon: 53.0 },
            'tehran': { name: 'Tehran, Iran', lat: 35.69, lon: 51.39 },
            'israel': { name: 'Israel', lat: 31.5, lon: 35.0 },
            'gaza': { name: 'Gaza', lat: 31.5, lon: 34.45 },
            'palestine': { name: 'Palestine', lat: 31.9, lon: 35.2 },
            'lebanon': { name: 'Lebanon', lat: 33.9, lon: 35.5 },
            'beirut': { name: 'Beirut, Lebanon', lat: 33.89, lon: 35.5 },
            'hezbollah': { name: 'Lebanon', lat: 33.9, lon: 35.5 },
            'syria': { name: 'Syria', lat: 35.0, lon: 38.0 },
            'damascus': { name: 'Damascus, Syria', lat: 33.51, lon: 36.28 },
            'yemen': { name: 'Yemen', lat: 15.5, lon: 48.0 },
            'houthi': { name: 'Yemen', lat: 15.5, lon: 44.0 },
            'red sea': { name: 'Red Sea', lat: 20.0, lon: 38.0 },
            'china': { name: 'China', lat: 35.0, lon: 105.0 },
            'beijing': { name: 'Beijing, China', lat: 39.9, lon: 116.4 },
            'taiwan': { name: 'Taiwan', lat: 23.5, lon: 121.0 },
            'taipei': { name: 'Taipei, Taiwan', lat: 25.03, lon: 121.56 },
            'north korea': { name: 'North Korea', lat: 39.0, lon: 125.75 },
            'pyongyang': { name: 'Pyongyang, DPRK', lat: 39.03, lon: 125.75 },
            'south korea': { name: 'South Korea', lat: 36.5, lon: 127.0 },
            'seoul': { name: 'Seoul, South Korea', lat: 37.57, lon: 126.98 },
            'japan': { name: 'Japan', lat: 36.2, lon: 138.25 },
            'tokyo': { name: 'Tokyo, Japan', lat: 35.68, lon: 139.69 },
            'venezuela': { name: 'Venezuela', lat: 8.0, lon: -66.0 },
            'caracas': { name: 'Caracas, Venezuela', lat: 10.48, lon: -66.9 },
            'greenland': { name: 'Greenland', lat: 72.0, lon: -42.0 },
            'nato': { name: 'Brussels (NATO HQ)', lat: 50.85, lon: 4.35 },
            'pentagon': { name: 'Pentagon, USA', lat: 38.87, lon: -77.06 },
            'washington': { name: 'Washington DC', lat: 38.9, lon: -77.04 },
            'iraq': { name: 'Iraq', lat: 33.0, lon: 44.0 },
            'baghdad': { name: 'Baghdad, Iraq', lat: 33.31, lon: 44.37 },
            'saudi': { name: 'Saudi Arabia', lat: 24.0, lon: 45.0 },
            'hormuz': { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5 },
            'persian gulf': { name: 'Persian Gulf', lat: 26.0, lon: 52.0 },
            'baltic': { name: 'Baltic Sea', lat: 57.0, lon: 20.0 },
            'black sea': { name: 'Black Sea', lat: 43.0, lon: 35.0 },
            'mediterranean': { name: 'Mediterranean', lat: 35.0, lon: 18.0 },
            'afghanistan': { name: 'Afghanistan', lat: 33.0, lon: 65.0 },
            'kabul': { name: 'Kabul, Afghanistan', lat: 34.53, lon: 69.17 },
            'pakistan': { name: 'Pakistan', lat: 30.0, lon: 70.0 },
            'india': { name: 'India', lat: 20.6, lon: 79.0 },
            'myanmar': { name: 'Myanmar', lat: 19.75, lon: 96.1 },
            'philippines': { name: 'Philippines', lat: 13.0, lon: 122.0 },
            'south china sea': { name: 'South China Sea', lat: 15.0, lon: 115.0 }
        };

        function inferLocationFromNews(text) {
            if (!text) return null;
            const lowerText = text.toLowerCase();

            // Check each keyword
            for (const [keyword, location] of Object.entries(LOCATION_KEYWORDS)) {
                if (lowerText.includes(keyword)) {
                    return location;
                }
            }
            return null;
        }

        // Make more cards clickable
        document.querySelector('.card-header span[id="flights-badge"]')?.closest('.card-header')?.classList.add('clickable');

        console.log('[MODAL] Modal system initialized');

        // ============================================
        // MARITIME INFRASTRUCTURE VISUALIZATION
        // ============================================

        // Symbol cache to avoid recreating identical symbols
        const symbolCache = new Map();

        // Create oil rig/platform symbol
        function createPlatformSymbol(type, colorHex) {
            const cacheKey = `platform-${type}-${colorHex}`;
            if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey);

            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const cx = 16, cy = 16;

            ctx.shadowColor = colorHex;
            ctx.shadowBlur = 6;

            // Platform base
            ctx.fillStyle = colorHex;
            ctx.beginPath();
            ctx.rect(cx - 8, cy + 2, 16, 6);
            ctx.fill();

            // Derrick/tower
            ctx.strokeStyle = colorHex;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cx - 6, cy + 2);
            ctx.lineTo(cx, cy - 10);
            ctx.lineTo(cx + 6, cy + 2);
            ctx.stroke();

            // Cross bracing
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx - 4, cy - 2);
            ctx.lineTo(cx + 4, cy - 2);
            ctx.stroke();

            // Platform legs (for offshore)
            ctx.beginPath();
            ctx.moveTo(cx - 6, cy + 8);
            ctx.lineTo(cx - 8, cy + 14);
            ctx.moveTo(cx + 6, cy + 8);
            ctx.lineTo(cx + 8, cy + 14);
            ctx.stroke();

            const dataUrl = canvas.toDataURL();
            symbolCache.set(cacheKey, dataUrl);
            return dataUrl;
        }

        // Create vessel/ship symbol (cached by type+color, heading applied by Cesium)
        function createVesselSymbol(type, colorHex, heading = 0) {
            // Cache base symbol (rotation handled via Cesium billboard rotation property)
            const cacheKey = `vessel-${type}-${colorHex}`;
            if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey);

            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const cx = 16, cy = 16;

            // Ship points upward (north) - rotation applied by Cesium billboard
            ctx.shadowColor = colorHex;
            ctx.shadowBlur = 5;
            ctx.fillStyle = colorHex;
            ctx.strokeStyle = colorHex;

            // Ship hull shape
            ctx.beginPath();
            ctx.moveTo(cx, cy - 10);      // Bow
            ctx.lineTo(cx + 6, cy + 4);   // Starboard
            ctx.lineTo(cx + 5, cy + 8);   // Stern starboard
            ctx.lineTo(cx - 5, cy + 8);   // Stern port
            ctx.lineTo(cx - 6, cy + 4);   // Port
            ctx.closePath();
            ctx.fill();

            // Bridge/superstructure
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.8;
            ctx.fillRect(cx - 3, cy - 2, 6, 4);

            const dataUrl = canvas.toDataURL();
            symbolCache.set(cacheKey, dataUrl);
            return dataUrl;
        }

        // Create landing point symbol (cached)
        function createLandingPointSymbol(colorHex) {
            const cacheKey = `landing-${colorHex}`;
            if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey);

            const canvas = document.createElement('canvas');
            canvas.width = 20;
            canvas.height = 20;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const cx = 10, cy = 10;

            ctx.shadowColor = colorHex;
            ctx.shadowBlur = 4;
            ctx.fillStyle = colorHex;

            // Simple dot for landing point
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();

            const dataUrl = canvas.toDataURL();
            symbolCache.set(cacheKey, dataUrl);
            return dataUrl;
        }

        // Add offshore platform to globe
        function addPlatform(platform) {
            if (!platform.latitude || !platform.longitude) return;
            const id = platform.id;
            if (platformEntities.has(id)) return;

            const colorHex = platform.type?.includes('FPSO') ? '#ff9500' :
                            platform.type?.includes('Gas') ? '#00aaff' :
                            platform.type?.includes('LNG') ? '#00ddff' : '#ffa000';

            const color = Cesium.Color.fromCssColorString(colorHex);
            const platformImage = createPlatformSymbol(platform.type, colorHex);

            // Add to cluster source instead of viewer.entities for automatic clustering
            const entity = platformClusterSource.entities.add({
                name: platform.name,
                position: Cesium.Cartesian3.fromDegrees(platform.longitude, platform.latitude),
                billboard: {
                    image: platformImage,
                    width: 24,
                    height: 24,
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 8e6, 0.3),
                    disableDepthTestDistance: 0
                },
                label: {
                    text: platform.name,
                    font: '9px JetBrains Mono',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -18),
                    scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 2e6, 0),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2e6),
                    disableDepthTestDistance: 0
                }
            });

            entity.customData = {
                type: 'platform',
                name: platform.name,
                platformType: platform.type,
                operator: platform.operator,
                country: platform.country,
                region: platform.region,
                status: platform.status,
                notes: platform.notes
            };

            platformEntities.set(id, entity);
        }

        // Add submarine cable to globe
        function addSubmarineCable(cable) {
            if (!cable.geometry || !cable.geometry.coordinates) return;

            const coords = cable.geometry.coordinates;
            const isMulti = cable.geometry.type === 'MultiLineString';

            const colorHex = cable.properties?.is_planned ? '#555555' : '#00ff88';
            const color = Cesium.Color.fromCssColorString(colorHex);

            const segments = isMulti ? coords : [coords];

            segments.forEach((segment, idx) => {
                const positions = [];
                segment.forEach(coord => {
                    if (Array.isArray(coord) && coord.length >= 2) {
                        // Use lon, lat format (GeoJSON is [lon, lat])
                        positions.push(Cesium.Cartesian3.fromDegrees(coord[0], coord[1], 0));
                    }
                });

                if (positions.length >= 2) {
                    const entity = viewer.entities.add({
                        name: cable.properties?.name || 'Submarine Cable',
                        polyline: {
                            positions: positions,
                            width: 3,
                            material: new Cesium.PolylineGlowMaterialProperty({
                                glowPower: 0.25,
                                color: color.withAlpha(0.7)
                            }),
                            clampToGround: true,
                            show: maritimeLayersVisible.cables
                        }
                    });

                    entity.customData = {
                        type: 'cable',
                        name: cable.properties?.name,
                        length_km: cable.properties?.length_km,
                        rfs: cable.properties?.rfs,
                        owners: cable.properties?.owners,
                        is_planned: cable.properties?.is_planned
                    };

                    cableEntities.push(entity);
                }
            });
        }

        // Add landing point to globe
        function addLandingPoint(point) {
            if (!point.longitude || !point.latitude) return;
            const id = point.id || `lp-${point.longitude}-${point.latitude}`;
            if (landingPointEntities.has(id)) return;

            const colorHex = '#00ffaa';
            const color = Cesium.Color.fromCssColorString(colorHex);
            const lpImage = createLandingPointSymbol(colorHex);

            const entity = viewer.entities.add({
                name: point.name || 'Landing Point',
                position: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude),
                billboard: {
                    image: lpImage,
                    width: 12,
                    height: 12,
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.2, 5e6, 0.2),
                    disableDepthTestDistance: 0,
                    show: maritimeLayersVisible.landingPoints
                },
                label: {
                    text: point.name || '',
                    font: '8px JetBrains Mono',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -10),
                    scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 1e6, 0),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1e6),
                    disableDepthTestDistance: 0,
                    show: maritimeLayersVisible.landingPoints
                }
            });

            entity.customData = {
                type: 'landingPoint',
                name: point.name,
                country: point.country,
                cableCount: point.cableCount
            };

            landingPointEntities.set(id, entity);
        }

        // Add AIS vessel to globe
        function addAISVessel(vessel) {
            if (!vessel.latitude || !vessel.longitude) return;
            const id = vessel.mmsi;

            // Remove existing entity if present
            if (aisVesselEntities.has(id)) {
                viewer.entities.remove(aisVesselEntities.get(id));
            }

            const typeColors = {
                'Tanker': '#ff6600',
                'Cargo': '#00aaff',
                'Passenger': '#00ff00',
                'Military Operations': '#ff0040',
                'Fishing': '#ffff00',
                'Tug': '#aa00ff',
                'default': '#00ddff'
            };

            const colorHex = typeColors[vessel.shipTypeName] || typeColors['default'];
            const color = Cesium.Color.fromCssColorString(colorHex);
            const vesselImage = createVesselSymbol(vessel.shipTypeName, colorHex);

            // Convert heading to radians for Cesium rotation (heading is degrees from north)
            const headingRad = Cesium.Math.toRadians(vessel.heading || vessel.course || 0);

            const entity = viewer.entities.add({
                name: vessel.name || vessel.mmsi,
                position: Cesium.Cartesian3.fromDegrees(vessel.longitude, vessel.latitude),
                billboard: {
                    image: vesselImage,
                    width: 20,
                    height: 20,
                    rotation: -headingRad, // Cesium rotation is counter-clockwise
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 5e6, 0.3),
                    disableDepthTestDistance: 0,
                    show: maritimeLayersVisible.aisVessels
                },
                label: {
                    text: vessel.name || '',
                    font: '9px JetBrains Mono',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(0, -16),
                    scaleByDistance: new Cesium.NearFarScalar(1e4, 1, 2e6, 0),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2e6),
                    disableDepthTestDistance: 0,
                    show: maritimeLayersVisible.aisVessels
                }
            });

            entity.customData = {
                type: 'aisVessel',
                mmsi: vessel.mmsi,
                name: vessel.name,
                imo: vessel.imo,
                callsign: vessel.callsign,
                shipType: vessel.shipTypeName,
                speed: vessel.speed,
                course: vessel.course,
                heading: vessel.heading,
                destination: vessel.destination,
                navStatus: vessel.navStatus,
                length: vessel.dimensions?.length,
                width: vessel.dimensions?.width
            };

            aisVesselEntities.set(id, entity);
        }

        // Toggle maritime layer visibility
        function toggleMaritimeLayer(layer) {
            maritimeLayersVisible[layer] = !maritimeLayersVisible[layer];
            const show = maritimeLayersVisible[layer];

            if (show) {
                // Trigger LOD update to populate layer according to current zoom
                maritimeLOD.currentLevel = null; // Force refresh
                updateMaritimeLOD();

                // For cables, also show static layer primitives
                if (layer === 'cables' && staticLayers.cablesLoaded) {
                    staticLayers.setCablesVisible(true);
                }
                // For platforms, show the cluster source
                if (layer === 'platforms') {
                    platformClusterSource.show = true;
                }
            } else {
                // Hide existing entities
                switch(layer) {
                    case 'platforms':
                        // Use cluster source visibility toggle for better performance
                        platformClusterSource.show = false;
                        break;
                    case 'cables':
                        // Use high-performance static layer toggle
                        if (staticLayers.cablesLoaded) {
                            staticLayers.setCablesVisible(false);
                        }
                        // Also hide any entity-based cables
                        cableEntities.forEach(e => {
                            if (e.polyline) e.polyline.show = false;
                        });
                        break;
                    case 'landingPoints':
                        landingPointEntities.forEach(e => {
                            if (e.billboard) e.billboard.show = false;
                            if (e.label) e.label.show = false;
                        });
                        break;
                    case 'aisVessels':
                        aisVesselEntities.forEach(e => {
                            if (e.billboard) e.billboard.show = false;
                            if (e.label) e.label.show = false;
                        });
                        break;
                }
            }

            updateMaritimeCount();
            console.log(`[MARITIME] ${layer} layer: ${show ? 'visible' : 'hidden'}`);
        }

        // ============================================
        // INTERNET EXCHANGE POINTS (IXPs)
        // ============================================

        const ixpEntities = new Map();
        let ixpLayerVisible = true;
        let ixpData = { ixps: [] };

        // Create IXP symbol
        function createIXPSymbol(tier, colorHex) {
            const cacheKey = `ixp-${tier}-${colorHex}`;
            if (symbolCache.has(cacheKey)) return symbolCache.get(cacheKey);

            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const cx = 16, cy = 16;
            const size = tier === 1 ? 10 : tier === 2 ? 8 : 6;

            ctx.shadowColor = colorHex;
            ctx.shadowBlur = 8;
            ctx.fillStyle = colorHex;

            // Hexagon for IXP
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i - Math.PI / 2;
                const x = cx + size * Math.cos(angle);
                const y = cy + size * Math.sin(angle);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.closePath();
            ctx.fill();

            // Inner network symbol
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx - 3, cy);
            ctx.lineTo(cx + 3, cy);
            ctx.moveTo(cx, cy - 3);
            ctx.lineTo(cx, cy + 3);
            ctx.stroke();

            const dataUrl = canvas.toDataURL();
            symbolCache.set(cacheKey, dataUrl);
            return dataUrl;
        }

        // Add IXP to globe
        function addIXP(ixp) {
            if (!ixp.latitude || !ixp.longitude) return;
            const id = ixp.id;
            if (ixpEntities.has(id)) return;

            // Color by tier
            const tierColors = {
                1: '#ff00ff', // Tier 1: Magenta (major)
                2: '#aa00ff', // Tier 2: Purple (large)
                3: '#6600ff'  // Tier 3: Blue-purple (medium)
            };
            const colorHex = tierColors[ixp.tier] || '#6600ff';
            const ixpImage = createIXPSymbol(ixp.tier, colorHex);

            // Add to cluster source instead of viewer.entities for automatic clustering
            const entity = ixpClusterSource.entities.add({
                name: ixp.name,
                position: Cesium.Cartesian3.fromDegrees(ixp.longitude, ixp.latitude),
                billboard: {
                    image: ixpImage,
                    width: ixp.tier === 1 ? 24 : ixp.tier === 2 ? 20 : 16,
                    height: ixp.tier === 1 ? 24 : ixp.tier === 2 ? 20 : 16,
                    scaleByDistance: cesiumShared.scales.base,
                    disableDepthTestDistance: 0
                },
                label: {
                    text: ixp.name,
                    font: '10px JetBrains Mono',
                    fillColor: Cesium.Color.fromCssColorString(colorHex),
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: cesiumShared.offsets.labelAbove,
                    scaleByDistance: cesiumShared.scales.label,
                    distanceDisplayCondition: cesiumShared.distances.near
                }
            });

            entity.customData = {
                type: 'ixp',
                name: ixp.name,
                city: ixp.city,
                country: ixp.country,
                networks: ixp.net_count,
                tier: ixp.tier,
                website: ixp.website
            };

            ixpEntities.set(id, entity);
        }

        // Toggle IXP layer
        function toggleLayer(layer) {
            if (layer === 'ixps') {
                ixpLayerVisible = !ixpLayerVisible;
                // Use cluster source visibility for better performance
                ixpClusterSource.show = ixpLayerVisible;
                const btn = document.getElementById('btn-ixps');
                if (btn) btn.style.background = ixpLayerVisible ? 'var(--accent)' : '';
                console.log(`[IXP] Layer: ${ixpLayerVisible ? 'visible' : 'hidden'}`);
            }
        }

        // Load IXP data
        async function loadIXPData() {
            try {
                const res = await fetch('/api/ixp/exchanges?tier=3&limit=200');
                const data = await res.json();
                ixpData = data;

                // Clear existing from cluster source
                ixpEntities.forEach(e => ixpClusterSource.entities.remove(e));
                ixpEntities.clear();

                // Add IXPs
                if (data.ixps) {
                    data.ixps.forEach(ixp => addIXP(ixp));
                    console.log(`[IXP] Loaded ${data.ixps.length} Internet Exchange Points`);
                }
            } catch (error) {
                console.error('[IXP] Load error:', error);
            }
        }

        // IXP connection lines storage
        let ixpConnectionEntities = [];
        let currentIXPEntity = null;

        // Calculate distance between two lat/lon points (km)
        function haversineDistance(lat1, lon1, lat2, lon2) {
            const R = 6371; // Earth radius in km
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                      Math.sin(dLon/2) * Math.sin(dLon/2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
            return R * c;
        }

        // Get estimated peak traffic for IXP (rough estimates based on tier)
        function getIXPTraffic(ixp) {
            const trafficEstimates = {
                'DE-CIX Frankfurt': '14+ Tbps',
                'AMS-IX': '11+ Tbps',
                'LINX': '6+ Tbps',
                'Equinix': '8+ Tbps',
                'NL-ix': '3+ Tbps',
                'France-IX': '3+ Tbps',
                'MSK-IX': '4+ Tbps',
                'JPNAP': '2+ Tbps',
                'HKIX': '2+ Tbps',
                'SIX': '1.5+ Tbps',
                'Netnod': '1+ Tbps',
                'SwissIX': '1+ Tbps',
                'VIX': '1+ Tbps',
                'BCIX': '0.5+ Tbps',
                'ECIX': '0.5+ Tbps'
            };

            // Check for known IXPs
            for (const [name, traffic] of Object.entries(trafficEstimates)) {
                if (ixp.name && ixp.name.includes(name)) return traffic;
            }

            // Estimate based on tier and network count
            if (ixp.tier === 1) return '1+ Tbps';
            if (ixp.tier === 2 && ixp.networks > 200) return '500+ Gbps';
            if (ixp.tier === 2) return '100+ Gbps';
            return '10+ Gbps';
        }

        // Show IXP details panel
        function showIXPDetails(data, entity) {
            const panel = document.getElementById('ixp-detail-panel');
            if (!panel) return;

            currentIXPEntity = entity;

            // Get IXP position
            const position = entity.position?.getValue?.(Cesium.JulianDate.now());
            const cartographic = position ? Cesium.Cartographic.fromCartesian(position) : null;
            const ixpLat = cartographic ? Cesium.Math.toDegrees(cartographic.latitude) : 0;
            const ixpLon = cartographic ? Cesium.Math.toDegrees(cartographic.longitude) : 0;

            // Update basic info
            document.getElementById('ixp-detail-title').textContent = data.name || 'Unknown IXP';
            document.getElementById('ixp-location').textContent = `${data.city || 'Unknown'}, ${data.country || ''}`;

            // Tier badge
            const tierBadge = document.getElementById('ixp-tier-badge');
            tierBadge.className = `ixp-tier-badge tier-${data.tier || 3}`;
            const tierLabels = { 1: '★ Tier 1 - Global', 2: '◆ Tier 2 - Major', 3: '● Tier 3 - Regional' };
            tierBadge.innerHTML = `<span>${data.tier === 1 ? '★' : data.tier === 2 ? '◆' : '●'}</span> ${tierLabels[data.tier] || 'Regional'}`;

            // Stats
            document.getElementById('ixp-networks').textContent = data.networks ? `${data.networks}+` : 'N/A';
            document.getElementById('ixp-traffic').textContent = getIXPTraffic(data);

            // Find nearby IXPs (within 1000km)
            const nearbyIXPs = [];
            if (ixpData && ixpData.ixps) {
                ixpData.ixps.forEach(otherIXP => {
                    if (otherIXP.name === data.name) return;
                    const dist = haversineDistance(ixpLat, ixpLon, otherIXP.latitude, otherIXP.longitude);
                    if (dist < 1000) {
                        nearbyIXPs.push({ ...otherIXP, distance: dist });
                    }
                });
                nearbyIXPs.sort((a, b) => a.distance - b.distance);
            }

            // Populate nearby IXPs
            const nearbyIXPsContainer = document.getElementById('ixp-nearby-ixps');
            if (nearbyIXPs.length > 0) {
                nearbyIXPsContainer.innerHTML = nearbyIXPs.slice(0, 6).map(ixp => `
                    <div class="ixp-connection-item" onclick="flyToIXP('${ixp.name}')">
                        <div class="ixp-connection-icon ixp">🌐</div>
                        <div class="ixp-connection-info">
                            <div class="ixp-connection-name">${ixp.name}</div>
                            <div class="ixp-connection-detail">${ixp.city || ''} · ${ixp.net_count || '?'} networks</div>
                        </div>
                        <div class="ixp-connection-distance">${Math.round(ixp.distance)} km</div>
                    </div>
                `).join('');
            } else {
                nearbyIXPsContainer.innerHTML = '<div style="color: var(--text-dim); font-size: 0.75rem; padding: 10px;">No IXPs within 1000km</div>';
            }

            // Find nearby submarine cables (within 500km of landing points)
            const nearbyCables = [];
            if (state.submarineCables && state.submarineCables.landingPoints) {
                const landingPoints = state.submarineCables.landingPoints.features || [];
                const checkedCables = new Set();

                landingPoints.forEach(lp => {
                    const coords = lp.geometry?.coordinates;
                    if (!coords) return;
                    const dist = haversineDistance(ixpLat, ixpLon, coords[1], coords[0]);
                    if (dist < 500) {
                        const cableName = lp.properties?.cable_name || lp.properties?.name;
                        if (cableName && !checkedCables.has(cableName)) {
                            checkedCables.add(cableName);
                            nearbyCables.push({
                                name: cableName,
                                landingPoint: lp.properties?.name,
                                country: lp.properties?.country,
                                distance: dist,
                                lat: coords[1],
                                lon: coords[0]
                            });
                        }
                    }
                });
                nearbyCables.sort((a, b) => a.distance - b.distance);
            }

            // Populate nearby cables
            const nearbyCablesContainer = document.getElementById('ixp-nearby-cables');
            if (nearbyCables.length > 0) {
                nearbyCablesContainer.innerHTML = nearbyCables.slice(0, 6).map(cable => `
                    <div class="ixp-connection-item" onclick="flyToPosition(${cable.lat}, ${cable.lon})">
                        <div class="ixp-connection-icon cable">〰️</div>
                        <div class="ixp-connection-info">
                            <div class="ixp-connection-name">${cable.name}</div>
                            <div class="ixp-connection-detail">Landing: ${cable.landingPoint || cable.country || 'Unknown'}</div>
                        </div>
                        <div class="ixp-connection-distance">${Math.round(cable.distance)} km</div>
                    </div>
                `).join('');
            } else {
                nearbyCablesContainer.innerHTML = '<div style="color: var(--text-dim); font-size: 0.75rem; padding: 10px;">No landing points within 500km</div>';
            }

            // External links
            const websiteLink = document.getElementById('ixp-website-link');
            const peeringdbLink = document.getElementById('ixp-peeringdb-link');

            if (data.website) {
                websiteLink.href = data.website;
                websiteLink.style.display = 'inline-flex';
            } else {
                websiteLink.style.display = 'none';
            }

            // PeeringDB search link
            peeringdbLink.href = `https://www.peeringdb.com/search?q=${encodeURIComponent(data.name)}`;

            // Draw connection lines
            clearIXPConnections();
            drawIXPConnections(ixpLat, ixpLon, nearbyIXPs.slice(0, 5), nearbyCables.slice(0, 5));

            // Show panel
            panel.classList.add('visible');

            // Fly to IXP with offset for panel
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(ixpLon - 5, ixpLat, 3000000),
                duration: 1.5,
                orientation: {
                    heading: 0,
                    pitch: Cesium.Math.toRadians(-60),
                    roll: 0
                }
            });
        }

        // Hide IXP details panel
        function hideIXPDetails() {
            const panel = document.getElementById('ixp-detail-panel');
            if (panel) panel.classList.remove('visible');
            clearIXPConnections();
            currentIXPEntity = null;
        }

        // Clear IXP connection lines
        function clearIXPConnections() {
            ixpConnectionEntities.forEach(e => viewer.entities.remove(e));
            ixpConnectionEntities = [];
        }

        // Draw connection lines from IXP to nearby IXPs and cables
        function drawIXPConnections(ixpLat, ixpLon, nearbyIXPs, nearbyCables) {
            // Draw lines to nearby IXPs (cyan dashed)
            nearbyIXPs.forEach(otherIXP => {
                const entity = viewer.entities.add({
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray([
                            ixpLon, ixpLat, otherIXP.longitude, otherIXP.latitude
                        ]),
                        width: 2,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.CYAN.withAlpha(0.6),
                            dashLength: 16
                        }),
                        arcType: Cesium.ArcType.GEODESIC,
                        clampToGround: false
                    }
                });
                ixpConnectionEntities.push(entity);
            });

            // Draw lines to nearby cable landing points (green dashed)
            nearbyCables.forEach(cable => {
                const entity = viewer.entities.add({
                    polyline: {
                        positions: Cesium.Cartesian3.fromDegreesArray([
                            ixpLon, ixpLat, cable.lon, cable.lat
                        ]),
                        width: 2,
                        material: new Cesium.PolylineDashMaterialProperty({
                            color: Cesium.Color.fromCssColorString('#00ffaa').withAlpha(0.6),
                            dashLength: 12
                        }),
                        arcType: Cesium.ArcType.GEODESIC,
                        clampToGround: false
                    }
                });
                ixpConnectionEntities.push(entity);
            });
        }

        // Fly to specific IXP by name
        function flyToIXP(ixpName) {
            if (!ixpData || !ixpData.ixps) return;
            const ixp = ixpData.ixps.find(i => i.name === ixpName);
            if (ixp) {
                // Find entity and trigger detail view
                const entity = Array.from(ixpEntities.values()).find(e =>
                    e.customData && e.customData.name === ixpName
                );
                if (entity && entity.customData) {
                    showIXPDetails(entity.customData, entity);
                } else {
                    viewer.camera.flyTo({
                        destination: Cesium.Cartesian3.fromDegrees(ixp.longitude, ixp.latitude, 2000000),
                        duration: 1.5
                    });
                }
            }
        }

        // Fly to specific position
        function flyToPosition(lat, lon) {
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(lon, lat, 500000),
                duration: 1.5
            });
        }

        // ============================================
        // SETTINGS PANEL
        // ============================================

        function toggleSettingsPanel() {
            const panel = document.getElementById('settings-panel');
            if (!panel) return;
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') {
                updateSettingsPanel();
            }
        }

        function updateSettingsPanel() {
            const content = document.getElementById('layer-settings-content');
            if (!content) return;

            const layers = [
                { key: 'flights', name: 'Flights', icon: '✈️' },
                { key: 'vessels', name: 'Vessels', icon: '🚢' },
                { key: 'platforms', name: 'Platforms', icon: '🛢️' },
                { key: 'cables', name: 'Cables', icon: '🔌' },
                { key: 'ixps', name: 'IXPs', icon: '🌐' },
                { key: 'seismic', name: 'Seismic', icon: '🌋' }
            ];

            content.innerHTML = layers.map(layer => {
                const settings = layerSettings[layer.key];
                return `
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; padding:4px; background:rgba(0,0,0,0.3); border-radius:3px;">
                        <span>${layer.icon} ${layer.name}</span>
                        <select onchange="updateLayerDetail('${layer.key}', this.value)" style="background:#111; color:var(--text); border:1px solid var(--border); padding:2px 4px; font-size:0.65rem; border-radius:2px;">
                            <option value="low" ${settings.detail === 'low' ? 'selected' : ''}>Low</option>
                            <option value="medium" ${settings.detail === 'medium' ? 'selected' : ''}>Medium</option>
                            <option value="high" ${settings.detail === 'high' ? 'selected' : ''}>High</option>
                            <option value="ultra" ${settings.detail === 'ultra' ? 'selected' : ''}>Ultra</option>
                        </select>
                    </div>
                `;
            }).join('');

            // Update perf stats
            const stats = document.getElementById('perf-stats');
            if (stats) {
                const report = perfMetrics.getReport();
                stats.innerHTML = `Entities: ${report.entities} | ${report.memory}`;
            }
        }

        // ============================================
        // INTERNET HEALTH PANEL
        // ============================================

        let healthPanelVisible = false;
        let healthUpdateInterval = null;

        function toggleHealthPanel() {
            const panel = document.getElementById('health-panel');
            if (!panel) return;
            healthPanelVisible = !healthPanelVisible;
            panel.style.display = healthPanelVisible ? 'block' : 'none';

            if (healthPanelVisible) {
                updateHealthPanel();
                // Auto-refresh while open
                healthUpdateInterval = setInterval(updateHealthPanel, 10000);
            } else if (healthUpdateInterval) {
                clearInterval(healthUpdateInterval);
            }
        }

        async function updateHealthPanel() {
            if (!dataFlowSystem.healthData) return;

            const data = dataFlowSystem.healthData;

            // Update score
            const scoreEl = document.getElementById('health-score');
            const statusEl = document.getElementById('health-status');
            const updatedEl = document.getElementById('health-updated');

            if (scoreEl) {
                const score = data.healthScore || 0;
                scoreEl.textContent = score + '%';
                scoreEl.style.color = score >= 90 ? '#00ff88' :
                                     score >= 70 ? '#ffaa00' : '#ff3333';
            }

            if (statusEl) {
                statusEl.textContent = data.status || 'Unknown';
                statusEl.style.color = data.status === 'healthy' ? '#00ff88' :
                                      data.status === 'degraded' ? '#ffaa00' : '#ff3333';
            }

            if (updatedEl) {
                updatedEl.textContent = 'Updated: ' + new Date(data.timestamp).toLocaleTimeString();
            }

            // Update active issues
            const issuesEl = document.getElementById('health-issues');
            if (issuesEl && data.activeIssues) {
                if (data.activeIssues.length === 0) {
                    issuesEl.innerHTML = '<div style="color:#00ff88;">✓ No active issues</div>';
                } else {
                    issuesEl.innerHTML = data.activeIssues.slice(0, 5).map(issue => {
                        const color = issue.severity === 'critical' ? '#ff3333' :
                                     issue.severity === 'high' ? '#ffaa00' : '#ffff00';
                        const icon = issue.type === 'outage' ? '🔴' :
                                    issue.type === 'cable_incident' ? '🔌' : '📡';
                        return `
                            <div style="margin-bottom:6px; padding:4px; background:rgba(0,0,0,0.3); border-left:2px solid ${color};">
                                <div>${icon} <strong style="color:${color}">${issue.severity?.toUpperCase()}</strong></div>
                                <div style="color:var(--text);">${issue.title || issue.description || issue.location}</div>
                            </div>
                        `;
                    }).join('');
                }
            }

            // Update cable status
            const cablesEl = document.getElementById('health-cables');
            if (cablesEl && data.cableStatus) {
                const problemCables = data.cableStatus.filter(c => c.status !== 'operational');
                if (problemCables.length === 0) {
                    cablesEl.innerHTML = '<div style="color:#00ff88;">✓ All critical cables operational</div>';
                } else {
                    cablesEl.innerHTML = problemCables.slice(0, 4).map(cable => {
                        const statusColor = cable.status === 'down' ? '#ff3333' :
                                           cable.status === 'degraded' ? '#ffaa00' : '#ffff00';
                        return `
                            <div style="display:flex; justify-content:space-between; margin-bottom:4px; padding:3px; background:rgba(0,0,0,0.3);">
                                <span>🔌 ${cable.name}</span>
                                <span style="color:${statusColor};">${cable.status.toUpperCase()} ${cable.latencyImpact ? `+${Math.round(cable.latencyImpact)}ms` : ''}</span>
                            </div>
                        `;
                    }).join('');
                }
            }

            // Update IXP connections
            const ixpEl = document.getElementById('health-ixp-connections');
            if (ixpEl && data.ixpConnections) {
                ixpEl.innerHTML = data.ixpConnections.slice(0, 5).map(conn => {
                    const statusColor = conn.status === 'operational' ? '#00ff88' :
                                       conn.status === 'degraded' ? '#ffaa00' : '#ff3333';
                    return `
                        <div style="display:flex; justify-content:space-between; margin-bottom:3px; font-size:0.6rem;">
                            <span style="color:var(--text-dim);">${conn.from.name.split(' ')[0]} ↔ ${conn.to.name.split(' ')[0]}</span>
                            <span style="color:${statusColor};">${conn.traffic?.current || '--'} Gbps | ${conn.latency}ms</span>
                        </div>
                    `;
                }).join('');
            }

            // Update dataflow stats
            const dfStatus = document.getElementById('dataflow-status');
            const dfArcs = document.getElementById('dataflow-arcs');
            const dfPackets = document.getElementById('dataflow-packets');

            if (dfStatus) dfStatus.textContent = dataFlowSystem.enabled ? 'ON' : 'OFF';
            if (dfArcs) dfArcs.textContent = dataFlowSystem.arcEntities.length;
            if (dfPackets) dfPackets.textContent = dataFlowSystem.packetEntities.length;
        }

        // Toggle data flow visualization
        function toggleDataFlow() {
            const enabled = dataFlowSystem.toggle();
            const btn = document.getElementById('btn-dataflow');
            if (btn) {
                btn.style.background = enabled ? 'var(--accent)' : '';
            }
            console.log(`[UI] Data flow: ${enabled ? 'enabled' : 'disabled'}`);
        }

        // Toggle legend collapse
        function toggleLegend() {
            const legend = document.getElementById('legend-panel');
            if (legend) {
                legend.classList.toggle('collapsed');
                const toggle = legend.querySelector('.legend-toggle');
                if (toggle) {
                    toggle.textContent = legend.classList.contains('collapsed') ? '▶' : '▼';
                }
            }
        }

        // Update quick stats bar with current data
        function updateQuickStats() {
            // Health score
            const healthEl = document.getElementById('qs-health');
            if (healthEl) {
                const score = state.internetHealth?.healthScore || 0;
                const statusClass = score >= 80 ? '' : score >= 50 ? 'warning' : 'critical';
                healthEl.className = `quick-stat ${statusClass}`;
                const valEl = document.getElementById('qs-health-val');
                if (valEl) valEl.textContent = score ? `${score}%` : '--';
            }

            // Flights
            const flightsEl = document.getElementById('qs-flights');
            if (flightsEl) {
                const count = flightEntities?.size || 0;
                const valEl = document.getElementById('qs-flights-val');
                if (valEl) valEl.textContent = count;
            }

            // Vessels
            const vesselsEl = document.getElementById('qs-vessels');
            if (vesselsEl) {
                const count = aisVesselEntities?.size || 0;
                const valEl = document.getElementById('qs-vessels-val');
                if (valEl) valEl.textContent = count;
            }

            // Seismic
            const seismicEl = document.getElementById('qs-seismic');
            if (seismicEl) {
                const count = state.seismic?.summary?.totalEvents || earthquakeEntities?.size || 0;
                const maxMag = state.seismic?.summary?.maxMagnitude || 0;
                const valEl = document.getElementById('qs-seismic-val');
                if (valEl) valEl.textContent = count;
                // Update label with max magnitude
                const labelEl = seismicEl.querySelector('.quick-stat-label');
                if (labelEl && maxMag > 0) labelEl.textContent = `M${maxMag.toFixed(1)}`;
                // Add warning class for significant quakes
                seismicEl.className = `quick-stat ${maxMag >= 5 ? 'warning' : maxMag >= 6 ? 'critical' : ''}`;
            }

            // Alerts
            const alertsEl = document.getElementById('qs-alerts');
            if (alertsEl) {
                const alertCount = state.alerts?.length || 0;
                const highCount = state.alerts?.filter(a => a.severity === 'HIGH' || a.severity === 'CRITICAL').length || 0;
                const statusClass = highCount > 0 ? 'critical' : alertCount > 0 ? 'warning' : '';
                alertsEl.className = `quick-stat ${statusClass}`;
                const valEl = document.getElementById('qs-alerts-val');
                if (valEl) valEl.textContent = alertCount;
            }
        }

        // Call updateQuickStats periodically
        setInterval(updateQuickStats, 5000);

        function updateLayerDetail(layer, detail) {
            if (layerSettings[layer]) {
                layerSettings[layer].detail = detail;
                console.log(`[SETTINGS] ${layer} detail set to ${detail}`);
                // Force LOD update
                maritimeLOD.currentLevel = null;
                updateMaritimeLOD();
            }
        }

        // Initialize IXP data after maritime
        setTimeout(loadIXPData, 5000);

        // Update maritime count in status bar
        function updateMaritimeCount() {
            const displayed = platformEntities.size + aisVesselEntities.size + cableEntities.length;
            const cached = maritimeLOD.data.platforms.length + maritimeLOD.data.vessels.length + maritimeLOD.data.cables.length;
            const el = document.getElementById('maritime-count');
            if (el) {
                const level = maritimeLOD.currentLevel.toUpperCase().slice(0, 3);
                el.textContent = `${displayed}/${cached} MARITIME [${level}]`;
                el.title = `Displaying ${displayed} of ${cached} cached items | LOD: ${maritimeLOD.currentLevel}`;
            }
        }

        // Update platforms display
        function updatePlatformsDisplay(data) {
            if (!data || !data.platforms) return;

            data.platforms.forEach(platform => {
                addPlatform(platform);
            });

            updateMaritimeCount();
            console.log(`[MARITIME] Displayed ${platformEntities.size} offshore platforms`);
        }

        // Update cables display
        function updateCablesDisplay(data) {
            if (!data || !data.cables) return;

            const features = data.cables.features || [];
            features.forEach(cable => {
                addSubmarineCable(cable);
            });

            // Add landing points
            if (data.landingPoints && data.landingPoints.features) {
                data.landingPoints.features.forEach(feature => {
                    const lp = {
                        id: feature.properties?.id,
                        name: feature.properties?.name,
                        country: feature.properties?.country,
                        longitude: feature.geometry?.coordinates?.[0],
                        latitude: feature.geometry?.coordinates?.[1],
                        cableCount: feature.properties?.cable_count
                    };
                    addLandingPoint(lp);
                });
            }

            submarineCablesLoaded = true;
            updateMaritimeCount();
            console.log(`[MARITIME] Displayed ${cableEntities.length} submarine cables, ${landingPointEntities.size} landing points`);
        }

        // Update AIS vessels display
        function updateAISVesselsDisplay(data) {
            if (!data || !data.vessels) return;

            data.vessels.forEach(vessel => {
                addAISVessel(vessel);
            });

            updateMaritimeCount();
            console.log(`[MARITIME] Tracking ${aisVesselEntities.size} AIS vessels`);
        }

        // Socket listeners for maritime data
        socket.on('offshore-platforms-update', (data) => {
            state.offshorePlatforms = data;
            updatePlatformsDisplay(data);
        });

        socket.on('submarine-cables-update', (data) => {
            state.submarineCables = data;
            updateCablesDisplay(data);
        });

        socket.on('ais-vessels-update', (data) => {
            state.aisVessels = data;
            updateAISVesselsDisplay(data);
            debouncedQuickStats();
        });

        // Internet health real-time updates (cable status, IXP traffic, outages)
        socket.on('internet-health-update', (data) => {
            state.internetHealth = data;
            // Update data flow system with new health data
            if (typeof dataFlowSystem !== 'undefined') {
                dataFlowSystem.healthData = data;
                dataFlowSystem.updateAnimationFromHealth();
                dataFlowSystem.updateArcColors();
                // Recreate arcs if connections changed
                if (data.ixpConnections?.length !== dataFlowSystem.ixpArcs.length) {
                    dataFlowSystem.createIXPArcs();
                }
            }
            // Update health panel if visible
            if (healthPanelVisible) {
                updateHealthPanel();
            }
            // Update quick stats bar
            debouncedQuickStats();
            console.log(`[WS] Internet health update: ${data.healthScore}% (${data.status})`);
        });

        // Entities of interest updates (throttled)
        socket.on('entities-update', (data) => {
            if (data) state.entitiesOfInterest = data;
            // Don't auto-reload, let user refresh manually or wait for cooldown
        });

        // Priority flight alert
        socket.on('priority-flight', (flight) => {
            if (flight?.callsign) {
                console.log(`[ENTITY] Priority flight: ${flight.callsign}`);
            }
        });

        // Priority vessel alert
        socket.on('priority-vessel', (vessel) => {
            if (vessel) {
                console.log(`[ENTITY] Priority vessel: ${vessel.name || vessel.mmsi}`);
            }
        });

        // Entity analysis complete
        socket.on('entity-analysis', (analysis) => {
            if (analysis?.entityId) {
                console.log(`[ENTITY] Analysis complete: ${analysis.entityType} ${analysis.entityId}`);
            }
        });

        // German infrastructure updates (don't auto-reload to prevent memory issues)
        socket.on('german-infrastructure-update', (data) => {
            if (data) state.germanInfrastructure = data;
            // Don't auto-reload layer, user must toggle manually
        });

        // Fetch all data for a category (stores in LOD cache, doesn't display)
        async function fetchAllData(url, dataKey, batchSize = 200) {
            let offset = 0;
            let hasMore = true;
            const allData = [];

            while (hasMore) {
                try {
                    const res = await fetch(`${url}?limit=${batchSize}&offset=${offset}`);
                    const data = await res.json();

                    // Extract items based on data type
                    let items = [];
                    if (dataKey === 'platforms') items = data.platforms || [];
                    else if (dataKey === 'cables') items = data.cables?.features || [];
                    else if (dataKey === 'landingPoints') items = data.landingPoints?.features || [];
                    else if (dataKey === 'vessels') items = data.vessels || [];

                    allData.push(...items);

                    hasMore = data.pagination?.hasMore || false;
                    offset += batchSize;

                    // Small delay
                    if (hasMore) await new Promise(r => setTimeout(r, 50));
                } catch (error) {
                    console.error(`[LOD] Fetch error for ${dataKey}:`, error);
                    hasMore = false;
                }
            }

            return allData;
        }

        // Initialize maritime data with LOD system
        async function initMaritimeData() {
            console.log('[MARITIME] Loading data into LOD cache...');

            try {
                // Load all platforms into cache
                console.log('[MARITIME] Fetching platforms...');
                maritimeLOD.data.platforms = await fetchAllData('/api/maritime/platforms', 'platforms', 500);
                console.log(`[MARITIME] Cached ${maritimeLOD.data.platforms.length} platforms`);

                // Load all cables into cache AND as high-performance primitives
                console.log('[MARITIME] Fetching cables...');
                maritimeLOD.data.cables = await fetchAllData('/api/maritime/cables', 'cables', 200);
                console.log(`[MARITIME] Cached ${maritimeLOD.data.cables.length} cables`);

                // Load cables as primitives (high-performance mode)
                if (maritimeLOD.data.cables.length > 0) {
                    staticLayers.loadCablesAsPrimitives({ features: maritimeLOD.data.cables });
                }

                // Load vessels into cache
                console.log('[MARITIME] Fetching vessels...');
                maritimeLOD.data.vessels = await fetchAllData('/api/maritime/vessels', 'vessels', 500);
                console.log(`[MARITIME] Cached ${maritimeLOD.data.vessels.length} vessels`);

                // Initial LOD update
                updateMaritimeLOD();

                console.log('[MARITIME] LOD system initialized');
            } catch (error) {
                console.error('[MARITIME] Error initializing LOD:', error);
            }
        }

        // Listen for camera changes to update LOD
        let lodUpdateTimeout = null;
        viewer.camera.changed.addEventListener(() => {
            // Debounce LOD updates
            if (lodUpdateTimeout) clearTimeout(lodUpdateTimeout);
            lodUpdateTimeout = setTimeout(() => {
                updateMaritimeLOD();
            }, 300); // Update 300ms after camera stops moving
        });

        // Periodic vessel data refresh (AIS data changes)
        setInterval(async () => {
            if (maritimeLayersVisible.aisVessels) {
                try {
                    maritimeLOD.data.vessels = await fetchAllData('/api/maritime/vessels', 'vessels', 500);
                    updateMaritimeLOD();
                } catch (e) {
                    console.error('[LOD] Vessel refresh error:', e);
                }
            }
        }, 30000); // Refresh every 30 seconds

        // Initialize maritime data after other modules load
        setTimeout(initMaritimeData, 3000);

        // Make toggle function globally available
        window.toggleMaritimeLayer = toggleMaritimeLayer;

        console.log('[MARITIME] Maritime infrastructure module initialized');

