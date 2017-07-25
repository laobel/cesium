define([
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/PixelFormat',
        '../Core/buildModuleUrl',
        '../Renderer/Framebuffer',
        '../Renderer/PixelDatatype',
        '../Renderer/Sampler',
        '../Renderer/Texture',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        './PostProcess',
        './PostProcessStage'
    ], function(
        defineProperties,
        destroyObject,
        PixelFormat,
        buildModuleUrl,
        Framebuffer,
        PixelDatatype,
        Sampler,
        Texture,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        PostProcess,
        PostProcessStage) {
    'use strict';

    /**
     * Post process stage for ambient occlusion. Implements {@link PostProcessStage}.
     *
     * @alias PostProcessAmbientOcclusionStage
     * @constructor
     *
     * @private
     */
    function PostProcessAmbientOcclusionStage() {
        
        this._aoTexture = undefined;
        this._aoFramebuffer = undefined;
        this._aoPostProcess = undefined;

        var urlRandomNoiseTex = buildModuleUrl('Assets/Textures/HBAO/RandomNoiseTex.jpg');

        this._aoGenerateUniformValues = {
            randomTexture: urlRandomNoiseTex,           
            intensity: 4.0,
            bias: 0.0,
            lenCap: 0.25,
            stepSize: 2.0
        };

        this._aoBlurUniformValues = {
            kernelSize : 1.0
        };


        this._fragmentShader =
            'uniform sampler2D u_colorTexture; \n' +
            'uniform sampler2D u_aoTexture; \n' +
            'uniform bool u_HBAOonly; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main(void) \n' +
            '{ \n' +
            '    vec3 color = texture2D(u_colorTexture, v_textureCoordinates).rgb; \n' +
            '    vec3 ao = texture2D(u_aoTexture, v_textureCoordinates).rgb; \n' +           
            '    if(u_HBAOonly) \n' +
            '      gl_FragColor = vec4(ao, 1.0); \n' +
            '    else \n' +
            '      gl_FragColor = vec4(ao * color, 1.0); \n' +
            '} \n';

        this._uniformValues = {
            aoTexture : undefined,
            HBAOonly: false,
        };

        /**
         * @inheritdoc PostProcessStage#show
         */
        this.show = false;
    }

    defineProperties(PostProcessAmbientOcclusionStage.prototype, {
        /**
         * @inheritdoc PostProcessStage#ready
         */
        ready : {
            get : function() {
                return true;
            }
        },
        /**
         * @inheritdoc PostProcessStage#uniformValues
         */
        uniformValues : {
            get : function() {
                return this._uniformValues;
            }
        },
        /**
         * @inheritdoc PostProcessStage#fragmentShader
         */
        fragmentShader : {
            get : function() {
                return this._fragmentShader;
            }
        },
        /**
         * @inheritdoc PostProcessStage#uniformValues
         */
        aoGenerateUniformValues : {
            get : function() {
                return this._aoGenerateUniformValues;
            }
        },
        /**
         * @inheritdoc PostProcessStage#uniformValues
         */
        aoBlurUniformValues : {
            get : function() {
                return this._aoBlurUniformValues;
            }
        }

    });

    /**
     * @inheritdoc PostProcessStage#execute
     */
    PostProcessAmbientOcclusionStage.prototype.execute = function(frameState, inputColorTexture, inputDepthTexture, dirty) {
        if (!this.show) {
            return;
        }

        if (dirty) {
            destroyResources(this);
            createResources(this, frameState.context);
        }

        this._aoPostProcess.execute(frameState, inputColorTexture, inputDepthTexture, this._aoFramebuffer);
    };

    function createSampler() {
        return new Sampler({
            wrapS : TextureWrap.CLAMP_TO_EDGE,
            wrapT : TextureWrap.CLAMP_TO_EDGE,
            minificationFilter : TextureMinificationFilter.NEAREST,
            magnificationFilter : TextureMagnificationFilter.NEAREST
        });
    }

    function createResources(stage, context) {
        var screenWidth = context.drawingBufferWidth;
        var screenHeight = context.drawingBufferHeight;
        var aoTexture = new Texture({
            context : context,
            width : screenWidth,
            height : screenHeight,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
            sampler : createSampler()
        });
        var aoFramebuffer = new Framebuffer({
            context : context,
            colorTextures : [aoTexture],
            destroyAttachments : false
        });

        var aoGenerateUniformValues = stage._aoGenerateUniformValues;
        var aoBlurUniformValues = stage._aoBlurUniformValues;

        var aoGenerateShader =
            '#extension GL_OES_standard_derivatives : enable \n' +
            'uniform sampler2D u_colorTexture; \n' +
            'uniform sampler2D u_randomTexture; \n' +
            'uniform sampler2D u_depthTexture; \n' +           
            'uniform float u_intensity; \n' +
            'uniform float u_bias; \n' +
            'uniform float u_lenCap; \n' +
            'uniform float u_stepSize; \n' +
            'varying vec2 v_textureCoordinates; \n' +

            'vec2 ScreenToView(vec2 uv) \n' +
            '{ \n' +
            '   return vec2((uv.x * 2.0 - 1.0), ((1.0 - uv.y)*2.0 - 1.0)) ; \n' +
            '} \n' +
           
            //Reconstruct Normal from View position
            'vec3 GetNormal(vec3 posInCamera) \n' +
            '{ \n' +
            '  vec3 d1 = dFdx(posInCamera); ' +
            '  vec3 d2 = dFdy(posInCamera); ' +
            '  return normalize(cross(d2, d1)); ' +
            '} \n' +

            'void main(void) \n' +
            '{ \n' +
           
            '    float depth = texture2D(u_depthTexture, v_textureCoordinates).r; \n' +
            '    vec4 posInCamera = czm_inverseProjection * vec4(ScreenToView(v_textureCoordinates), depth, 1.0); \n' +
            '    posInCamera = posInCamera / posInCamera.w; \n' +
            '    vec3 normalInCamera = GetNormal(posInCamera.xyz); \n' +
           
            '    float AO = 0.0; \n' +
            '    vec2 sampleDirection = vec2(1.0, 0.0); \n' +
            '    float gapAngle = 90.0; \n' +

            // DegreeToRadian
            '    gapAngle *= 0.01745329252; \n' +

            // RandomNoise
            '    vec2 noiseMapSize = vec2(256.0, 256.0); \n' +
            '    vec2 noiseScale = vec2(czm_viewport.z /  noiseMapSize.x, czm_viewport.w / noiseMapSize.y); \n' +
            '    float randomVal = clamp(texture2D(u_randomTexture, v_textureCoordinates*noiseScale).x, 0.0, 1.0); \n' +

            //Loop for each direction
            '    for (int i = 0; i < 4; i++) \n' +
            '    { \n' +
            '       float newgapAngle = gapAngle * (float(i) + randomVal); \n' +
            '       float cosVal = cos(newgapAngle); \n' +
            '       float sinVal = sin(newgapAngle); \n' +

            //Rotate Sampling Direction
            '       vec2 rotatedSampleDirection = vec2(cosVal * sampleDirection.x - sinVal * sampleDirection.y, sinVal * sampleDirection.x + cosVal * sampleDirection.y); \n' +
            '       float localAO = 0.0; \n' +
            '       float localStepSize = u_stepSize; \n' +

            //Loop for each step
            '       for (int j = 0; j < 6; j++) \n' +
            '       { \n' +
            '            vec2 directionWithStep = vec2(rotatedSampleDirection.x * localStepSize * (1.0 / czm_viewport.z), rotatedSampleDirection.y * localStepSize * (1.0 / czm_viewport.w)); \n' +
            '            vec2 newCoords = directionWithStep + v_textureCoordinates; \n' +
            //Exception Handling
            '            if(newCoords.x > 1.0 || newCoords.y > 1.0 || newCoords.x < 0.0 || newCoords.y < 0.0) \n' +
            '               break; \n' +

            '            float stepDepthInfo = texture2D(u_depthTexture, newCoords).r; \n' +
            '            vec4 stepPosInCamera = czm_inverseProjection * vec4(ScreenToView(newCoords), stepDepthInfo, 1.0); \n' +
            '            stepPosInCamera = stepPosInCamera / stepPosInCamera.w; \n' +
            '            vec3 diffVec = stepPosInCamera.xyz - posInCamera.xyz; \n' +
            '            float len = length(diffVec); \n' +
         
            '            if(len <= u_lenCap) \n' +
            '            { \n' +
            '                  float dotVal = clamp(dot(normalInCamera, normalize(diffVec)), 0.0, 1.0 ); \n' +
            '                  float weight = len / u_lenCap; \n' +
            '                  weight = 1.0 - weight*weight; \n' +

            '                  if(dotVal < u_bias) \n' +
            '                     dotVal = 0.0; \n' +

            '                  localAO = max(localAO, dotVal * weight); \n' +
            '                  localStepSize += u_stepSize; \n' +
            '            } \n' +
            '            else \n' +
            '             break; \n' +
            '      } \n' +
            '    AO += localAO; \n' +
            '} \n' +

            ' AO /= float(4); \n' +
            ' AO = 1.0 - clamp(AO, 0.0, 1.0); \n' +
            ' AO = pow(AO, u_intensity); \n' +
            ' gl_FragColor = vec4(vec3(AO), 1.0); \n' +            
            '} \n';

        var aoBlurXShader =
            'uniform sampler2D u_colorTexture; \n' +
            'uniform float u_kernelSize; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main(void) \n' +
            '{ \n' +
            '    vec4 result = vec4(0.0); \n' +
            '    vec2 recipalScreenSize = u_kernelSize / czm_viewport.zw; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(-recipalScreenSize.x*4.0, 0.0))*0.00390625; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(-recipalScreenSize.x*3.0, 0.0))*0.03125; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(-recipalScreenSize.x*2.0, 0.0))*0.109375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(-recipalScreenSize.x, 0.0))*0.21875; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates)*0.2734375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(recipalScreenSize.x, 0.0))*0.21875; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(recipalScreenSize.x*2.0, 0.0))*0.109375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(recipalScreenSize.x*3.0, 0.0))*0.03125; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(recipalScreenSize.x*4.0, 0.0))*0.00390625; \n' +           
            '    gl_FragColor = result; \n' +
            '} \n';

        var aoBlurYShader =
            'uniform sampler2D u_colorTexture; \n' +
            'uniform float u_kernelSize; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main(void) \n' +
            '{ \n' +
            '    vec4 result = vec4(0.0); \n' +
            '    vec2 recipalScreenSize = u_kernelSize / czm_viewport.zw; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, -recipalScreenSize.y*4.0))*0.00390625; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, -recipalScreenSize.y*3.0))*0.03125; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, -recipalScreenSize.y*2.0))*0.109375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, -recipalScreenSize.y))*0.21875; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates)*0.2734375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, recipalScreenSize.y))*0.21875; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, recipalScreenSize.y*2.0))*0.109375; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, recipalScreenSize.y*3.0))*0.03125; \n' +
            '    result += texture2D(u_colorTexture, v_textureCoordinates + vec2(0.0, recipalScreenSize.y*4.0))*0.00390625; \n' +           
            '    gl_FragColor = result; \n' +
            '} \n';

        var aoGenerateStage = new PostProcessStage({
            fragmentShader : aoGenerateShader,
            uniformValues: aoGenerateUniformValues
        });

        var aoBlurXStage = new PostProcessStage({
            fragmentShader : aoBlurXShader,
            uniformValues: aoBlurUniformValues
        });

        var aoBlurYStage = new PostProcessStage({
            fragmentShader : aoBlurYShader,
            uniformValues: aoBlurUniformValues
        });

        var aoPostProcess = new PostProcess({
            stages : [aoGenerateStage, aoBlurXStage, aoBlurYStage],
            overwriteInput : false,
            blendOutput : false
        });

        aoGenerateStage.show = true;
        aoBlurXStage.show = true;
        aoBlurYStage.show = true;

        stage._aoTexture = aoTexture;
        stage._aoFramebuffer = aoFramebuffer;
        stage._aoPostProcess = aoPostProcess;
        stage._uniformValues.aoTexture = aoTexture;
    }

    function destroyResources(stage) {
        stage._aoTexture = stage._aoTexture && stage._aoTexture.destroy();
        stage._aoFramebuffer = stage._aoFramebuffer && stage._aoFramebuffer.destroy();
        stage._aoPostProcess = stage._aoPostProcess && stage._aoPostProcess.destroy();
    }

    /**
     * @inheritdoc PostProcessStage#isDestroyed
     */
    PostProcessAmbientOcclusionStage.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * @inheritdoc PostProcessStage#destroy
     */
    PostProcessAmbientOcclusionStage.prototype.destroy = function() {
        destroyResources(this);
        return destroyObject(this);
    };

    return PostProcessAmbientOcclusionStage;
});