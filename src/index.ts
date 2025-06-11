#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from 'http';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { fal } from '@fal-ai/client';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';

// Configure FAL client - will be lazily configured when needed
function configureFalClient() {
  if (!process.env.FAL_KEY) {
    throw new Error('FAL_KEY environment variable is required. Please configure your API key.');
  }
  fal.config({
    credentials: process.env.FAL_KEY,
  });
}

// Configure download path
const DOWNLOAD_PATH = process.env.DOWNLOAD_PATH || path.join(os.homedir(), 'Downloads');

// Configure data URL behavior
const ENABLE_DATA_URLS = process.env.ENABLE_DATA_URLS === 'true'; // Default: false (optimized for Claude Desktop)
const MAX_DATA_URL_SIZE = parseInt(process.env.MAX_DATA_URL_SIZE || '2097152'); // Default: 2MB

// Configure auto-open behavior
const AUTOOPEN = process.env.AUTOOPEN !== 'false'; // Default: true (automatically open generated files)

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_PATH)) {
  fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
}

// Dynamic model registry - this could be updated via API call
const MODEL_REGISTRY = {
  imageGeneration: [
    { id: 'imagen4', endpoint: 'fal-ai/imagen4/preview', name: 'Imagen 4', description: 'Google\'s latest text-to-image model' },
    { id: 'flux_kontext', endpoint: 'fal-ai/flux-pro/kontext', name: 'FLUX Kontext Pro', description: 'State-of-the-art prompt adherence and typography' },
    { id: 'ideogram_v3', endpoint: 'fal-ai/ideogram/v3', name: 'Ideogram V3', description: 'Advanced typography and realistic outputs' },
    { id: 'recraft_v3', endpoint: 'fal-ai/recraft/v3/text-to-image', name: 'Recraft V3', description: 'Professional design and illustration' },
    { id: 'stable_diffusion_35', endpoint: 'fal-ai/stable-diffusion-v35-large', name: 'Stable Diffusion 3.5 Large', description: 'Improved image quality and performance' },
    { id: 'flux_dev', endpoint: 'fal-ai/flux/dev', name: 'FLUX Dev', description: 'High-quality 12B parameter model' },
    { id: 'hidream', endpoint: 'fal-ai/hidream-i1-full', name: 'HiDream I1', description: 'High-resolution image generation' },
    { id: 'janus', endpoint: 'fal-ai/janus', name: 'Janus', description: 'Multimodal understanding and generation' }
  ],
  textToVideo: [
    { id: 'veo3', endpoint: 'fal-ai/veo3', name: 'Veo 3', description: 'Google DeepMind\'s latest with speech and audio' },
    { id: 'kling_master_text', endpoint: 'fal-ai/kling-video/v2.1/master/text-to-video', name: 'Kling 2.1 Master', description: 'Premium text-to-video with motion fluidity' },
    { id: 'pixverse_text', endpoint: 'fal-ai/pixverse/v4.5/text-to-video', name: 'Pixverse V4.5', description: 'Advanced text-to-video generation' },
    { id: 'magi', endpoint: 'fal-ai/magi', name: 'Magi', description: 'Creative video generation' },
    { id: 'luma_ray2', endpoint: 'fal-ai/luma-dream-machine/ray-2', name: 'Luma Ray 2', description: 'Latest Luma Dream Machine' },
    { id: 'wan_pro_text', endpoint: 'fal-ai/wan-pro/text-to-video', name: 'Wan Pro', description: 'Professional video effects' },
    { id: 'vidu_text', endpoint: 'fal-ai/vidu/q1/text-to-video', name: 'Vidu Q1', description: 'High-quality text-to-video' }
  ],
  imageToVideo: [
    { id: 'kling_master_image', endpoint: 'fal-ai/kling-video/v2.1/master/image-to-video', name: 'Kling 2.1 Master I2V', description: 'Premium image-to-video conversion' },
    { id: 'pixverse_image', endpoint: 'fal-ai/pixverse/v4.5/image-to-video', name: 'Pixverse V4.5 I2V', description: 'Advanced image-to-video' },
    { id: 'wan_pro_image', endpoint: 'fal-ai/wan-pro/image-to-video', name: 'Wan Pro I2V', description: 'Professional image animation' },
    { id: 'hunyuan_image', endpoint: 'fal-ai/hunyuan-video-image-to-video', name: 'Hunyuan I2V', description: 'Open-source image-to-video' },
    { id: 'vidu_image', endpoint: 'fal-ai/vidu/image-to-video', name: 'Vidu I2V', description: 'High-quality image animation' },
    { id: 'luma_ray2_image', endpoint: 'fal-ai/luma-dream-machine/ray-2/image-to-video', name: 'Luma Ray 2 I2V', description: 'Latest Luma image-to-video' }
  ]
};

// Helper function to get all models
function getAllModels() {
  return [
    ...MODEL_REGISTRY.imageGeneration,
    ...MODEL_REGISTRY.textToVideo,
    ...MODEL_REGISTRY.imageToVideo
  ];
}

// Helper function to get model by ID
function getModelById(id: string) {
  const allModels = getAllModels();
  return allModels.find(model => model.id === id);
}

interface FalImageResult {
  images: Array<{
    url: string;
    width: number;
    height: number;
  }>;
}

interface FalVideoResult {
  video: {
    url: string;
    width: number;
    height: number;
  };
}

async function urlToDataUrl(url: string): Promise<string | null> {
  if (!ENABLE_DATA_URLS) {
    return null;
  }

  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    
    // Check size limit
    if (buffer.byteLength > MAX_DATA_URL_SIZE) {
      console.error(`File too large for data URL: ${buffer.byteLength} bytes (max: ${MAX_DATA_URL_SIZE})`);
      return null;
    }
    
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    console.error('Error converting URL to data URL:', error);
    return null;
  }
}

async function downloadFile(url: string, filename: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const buffer = await response.arrayBuffer();
    const fullPath = path.join(DOWNLOAD_PATH, filename);
    
    fs.writeFileSync(fullPath, Buffer.from(buffer));
    console.error(`Downloaded: ${fullPath}`);
    
    return fullPath;
  } catch (error) {
    console.error('Error downloading file:', error);
    throw new Error(`Failed to download file: ${error}`);
  }
}

function generateFilename(type: 'image' | 'video', modelName: string, index?: number): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = index !== undefined ? `_${index}` : '';
  const extension = type === 'video' ? 'mp4' : 'jpg';
  return `fal_${modelName}_${timestamp}${suffix}.${extension}`;
}

async function autoOpenFile(filePath: string): Promise<void> {
  if (!AUTOOPEN) {
    return;
  }

  try {
    let command: string;
    
    // Cross-platform file opening
    switch (os.platform()) {
      case 'darwin':  // macOS
        command = `open "${filePath}"`;
        break;
      case 'win32':   // Windows
        command = `start "" "${filePath}"`;
        break;
      default:        // Linux and other Unix-like systems
        command = `xdg-open "${filePath}"`;
        break;
    }
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to auto-open file: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`Auto-open stderr: ${stderr}`);
        return;
      }
      console.error(`Auto-opened: ${filePath}`);
    });
  } catch (error) {
    console.error('Error auto-opening file:', error);
  }
}

async function downloadAndProcessImages(images: any[], modelName: string): Promise<any[]> {
  const processedImages = await Promise.all(
    images.map(async (image, index) => {
      const filename = generateFilename('image', modelName, images.length > 1 ? index : undefined);
      const localPath = await downloadFile(image.url, filename);
      const dataUrl = await urlToDataUrl(image.url);
      
      // Auto-open the downloaded image
      await autoOpenFile(localPath);
      
      const result: any = {
        url: image.url,
        localPath,
        width: image.width,
        height: image.height,
      };
      
      // Only include dataUrl if it was successfully generated
      if (dataUrl) {
        result.dataUrl = dataUrl;
      }
      
      return result;
    })
  );
  
  return processedImages;
}

async function downloadAndProcessVideo(videoUrl: string, modelName: string): Promise<any> {
  const filename = generateFilename('video', modelName);
  const localPath = await downloadFile(videoUrl, filename);
  const dataUrl = await urlToDataUrl(videoUrl);
  
  // Auto-open the downloaded video
  await autoOpenFile(localPath);
  
  const result: any = { localPath };
  
  // Only include dataUrl if it was successfully generated
  if (dataUrl) {
    result.dataUrl = dataUrl;
  }
  
  return result;
}

class FalMcpServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'fal-image-video-mcp',
        version: '1.0.2',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupConfigHandlers();
  }

  private generateToolSchema(model: any, category: string) {
    const baseSchema = {
      name: model.id,
      description: `${model.name} - ${model.description}`,
      inputSchema: {
        type: 'object',
        properties: {} as any,
        required: [] as string[],
      },
    };

    if (category === 'imageGeneration') {
      baseSchema.inputSchema.properties = {
        prompt: { type: 'string', description: 'Text prompt for image generation' },
        image_size: { type: 'string', enum: ['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'], default: 'landscape_4_3' },
        num_images: { type: 'number', default: 1, minimum: 1, maximum: 4 },
      };
      baseSchema.inputSchema.required = ['prompt'];
      
      // Add model-specific parameters
      if (model.id.includes('flux') || model.id.includes('stable_diffusion')) {
        baseSchema.inputSchema.properties.num_inference_steps = { type: 'number', default: 25, minimum: 1, maximum: 50 };
        baseSchema.inputSchema.properties.guidance_scale = { type: 'number', default: 3.5, minimum: 1, maximum: 20 };
      }
      if (model.id.includes('stable_diffusion') || model.id === 'ideogram_v3') {
        baseSchema.inputSchema.properties.negative_prompt = { type: 'string', description: 'Negative prompt' };
      }
    } else if (category === 'textToVideo') {
      baseSchema.inputSchema.properties = {
        prompt: { type: 'string', description: 'Text prompt for video generation' },
        duration: { type: 'number', default: 5, minimum: 1, maximum: 30 },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], default: '16:9' },
      };
      baseSchema.inputSchema.required = ['prompt'];
    } else if (category === 'imageToVideo') {
      baseSchema.inputSchema.properties = {
        image_url: { type: 'string', description: 'URL of the input image' },
        prompt: { type: 'string', description: 'Motion description prompt (optional)' },
        duration: { type: 'number', default: 5, minimum: 1, maximum: 30 },
        aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], default: '16:9' },
      };
      baseSchema.inputSchema.required = ['image_url'];
    }

    return baseSchema;
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [];
      
      // Generate tools for each category
      for (const model of MODEL_REGISTRY.imageGeneration) {
        tools.push(this.generateToolSchema(model, 'imageGeneration'));
      }
      for (const model of MODEL_REGISTRY.textToVideo) {
        tools.push(this.generateToolSchema(model, 'textToVideo'));
      }
      for (const model of MODEL_REGISTRY.imageToVideo) {
        tools.push(this.generateToolSchema(model, 'imageToVideo'));
      }

      // Add generic tools for model discovery and custom execution
      tools.push({
        name: 'list_available_models',
        description: 'List all available models in the current registry with their capabilities',
        inputSchema: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: ['all', 'imageGeneration', 'textToVideo', 'imageToVideo'],
              default: 'all',
              description: 'Filter models by category'
            }
          },
          required: []
        }
      });

      tools.push({
        name: 'execute_custom_model',
        description: 'Execute any FAL model by specifying the endpoint directly',
        inputSchema: {
          type: 'object',
          properties: {
            endpoint: {
              type: 'string',
              description: 'FAL model endpoint (e.g., fal-ai/flux/schnell, fal-ai/custom-model)'
            },
            input_params: {
              type: 'object',
              description: 'Input parameters for the model (varies by model)'
            },
            category_hint: {
              type: 'string',
              enum: ['image', 'video', 'image_to_video', 'other'],
              default: 'other',
              description: 'Hint about the expected output type for proper handling'
            }
          },
          required: ['endpoint', 'input_params']
        }
      });

      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        // Handle special tools first
        if (name === 'list_available_models') {
          return await this.handleListModels(args);
        } else if (name === 'execute_custom_model') {
          return await this.handleCustomModel(args);
        }

        const model = getModelById(name);
        if (!model) {
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown model: ${name}`
          );
        }

        // Determine category and handle accordingly
        if (MODEL_REGISTRY.imageGeneration.find(m => m.id === name)) {
          return await this.handleImageGeneration(args, model);
        } else if (MODEL_REGISTRY.textToVideo.find(m => m.id === name)) {
          return await this.handleTextToVideo(args, model);
        } else if (MODEL_REGISTRY.imageToVideo.find(m => m.id === name)) {
          return await this.handleImageToVideo(args, model);
        }
        
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unsupported model category for: ${name}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new McpError(ErrorCode.InternalError, errorMessage);
      }
    });
  }

  private async handleImageGeneration(args: any, model: any) {
    const {
      prompt,
      image_size = 'landscape_4_3',
      num_inference_steps = 25,
      guidance_scale = 3.5,
      num_images = 1,
      negative_prompt,
      safety_tolerance,
      raw,
    } = args;

    try {
      // Configure FAL client lazily
      configureFalClient();
      const inputParams: any = { prompt };
      
      // Add common parameters
      if (image_size) inputParams.image_size = image_size;
      if (num_images > 1) inputParams.num_images = num_images;
      
      // Add model-specific parameters based on model capabilities
      if (model.id.includes('flux') || model.id.includes('stable_diffusion')) {
        if (num_inference_steps) inputParams.num_inference_steps = num_inference_steps;
        if (guidance_scale) inputParams.guidance_scale = guidance_scale;
      }
      if ((model.id.includes('stable_diffusion') || model.id === 'ideogram_v3') && negative_prompt) {
        inputParams.negative_prompt = negative_prompt;
      }
      if (model.id.includes('flux_pro') && safety_tolerance) {
        inputParams.safety_tolerance = safety_tolerance;
      }
      if (model.id === 'flux_pro_ultra' && raw !== undefined) {
        inputParams.raw = raw;
      }

      const result = await fal.subscribe(model.endpoint, { input: inputParams });
      const imageData = result.data as FalImageResult;

      const processedImages = await downloadAndProcessImages(imageData.images, model.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              model: model.name,
              id: model.id,
              endpoint: model.endpoint,
              prompt,
              images: processedImages,
              metadata: inputParams,
              download_path: DOWNLOAD_PATH,
              data_url_settings: {
                enabled: ENABLE_DATA_URLS,
                max_size_mb: Math.round(MAX_DATA_URL_SIZE / 1024 / 1024),
              },
              autoopen_settings: {
                enabled: AUTOOPEN,
                note: AUTOOPEN ? "Files automatically opened with default application" : "Auto-open disabled"
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`${model.name} generation failed: ${error}`);
    }
  }

  private async handleImageToVideo(args: any, model: any) {
    const { image_url, prompt, duration = 5, aspect_ratio = '16:9' } = args;

    try {
      // Configure FAL client lazily
      configureFalClient();
      const inputParams: any = { image_url };
      
      if (prompt) inputParams.prompt = prompt;
      if (duration) inputParams.duration = duration;
      if (aspect_ratio) inputParams.aspect_ratio = aspect_ratio;

      const result = await fal.subscribe(model.endpoint, { input: inputParams });
      const videoData = result.data as FalVideoResult;
      const videoProcessed = await downloadAndProcessVideo(videoData.video.url, model.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              model: model.name,
              id: model.id,
              endpoint: model.endpoint,
              input_image: image_url,
              prompt,
              video: {
                url: videoData.video.url,
                localPath: videoProcessed.localPath,
                ...(videoProcessed.dataUrl && { dataUrl: videoProcessed.dataUrl }),
                width: videoData.video.width,
                height: videoData.video.height,
              },
              metadata: inputParams,
              download_path: DOWNLOAD_PATH,
              data_url_settings: {
                enabled: ENABLE_DATA_URLS,
                max_size_mb: Math.round(MAX_DATA_URL_SIZE / 1024 / 1024),
              },
              autoopen_settings: {
                enabled: AUTOOPEN,
                note: AUTOOPEN ? "Files automatically opened with default application" : "Auto-open disabled"
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`${model.name} generation failed: ${error}`);
    }
  }

  private async handleTextToVideo(args: any, model: any) {
    const { prompt, duration = 5, aspect_ratio = '16:9' } = args;

    try {
      // Configure FAL client lazily
      configureFalClient();
      const inputParams: any = { prompt };
      
      if (duration) inputParams.duration = duration;
      if (aspect_ratio) inputParams.aspect_ratio = aspect_ratio;

      const result = await fal.subscribe(model.endpoint, { input: inputParams });
      const videoData = result.data as FalVideoResult;
      const videoProcessed = await downloadAndProcessVideo(videoData.video.url, model.id);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              model: model.name,
              id: model.id,
              endpoint: model.endpoint,
              prompt,
              video: {
                url: videoData.video.url,
                localPath: videoProcessed.localPath,
                ...(videoProcessed.dataUrl && { dataUrl: videoProcessed.dataUrl }),
                width: videoData.video.width,
                height: videoData.video.height,
              },
              metadata: inputParams,
              download_path: DOWNLOAD_PATH,
              data_url_settings: {
                enabled: ENABLE_DATA_URLS,
                max_size_mb: Math.round(MAX_DATA_URL_SIZE / 1024 / 1024),
              },
              autoopen_settings: {
                enabled: AUTOOPEN,
                note: AUTOOPEN ? "Files automatically opened with default application" : "Auto-open disabled"
              },
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`${model.name} generation failed: ${error}`);
    }
  }

  private async handleListModels(args: any) {
    const { category = 'all' } = args;

    let modelsToList: any[] = [];
    
    if (category === 'all') {
      modelsToList = getAllModels();
    } else if (category === 'imageGeneration') {
      modelsToList = MODEL_REGISTRY.imageGeneration;
    } else if (category === 'textToVideo') {
      modelsToList = MODEL_REGISTRY.textToVideo;
    } else if (category === 'imageToVideo') {
      modelsToList = MODEL_REGISTRY.imageToVideo;
    }

    const modelList = modelsToList.map(model => ({
      id: model.id,
      name: model.name,
      description: model.description,
      endpoint: model.endpoint,
      category: MODEL_REGISTRY.imageGeneration.includes(model as any) ? 'imageGeneration' :
                MODEL_REGISTRY.textToVideo.includes(model as any) ? 'textToVideo' :
                MODEL_REGISTRY.imageToVideo.includes(model as any) ? 'imageToVideo' : 'unknown'
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total_models: modelList.length,
            category_filter: category,
            models: modelList,
            note: "Use 'execute_custom_model' to run any FAL endpoint not in this registry"
          }, null, 2),
        },
      ],
    };
  }

  private async handleCustomModel(args: any) {
    const { endpoint, input_params, category_hint = 'other' } = args;

    try {
      // Configure FAL client lazily
      configureFalClient();
      const result = await fal.subscribe(endpoint, { input: input_params });

      // Handle different output types based on category hint
      if (category_hint === 'image' || category_hint === 'other') {
        // Assume image output
        const data = result.data as any;
        if (data.images && Array.isArray(data.images)) {
          const processedImages = await downloadAndProcessImages(data.images, endpoint.replace(/[^a-zA-Z0-9]/g, '_'));
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  endpoint,
                  category_hint,
                  images: processedImages,
                  raw_output: data,
                  input_params,
                  download_path: DOWNLOAD_PATH,
                }, null, 2),
              },
            ],
          };
        }
      } else if (category_hint === 'video' || category_hint === 'image_to_video') {
        // Assume video output
        const data = result.data as any;
        if (data.video) {
          const videoProcessed = await downloadAndProcessVideo(data.video.url, endpoint.replace(/[^a-zA-Z0-9]/g, '_'));
          
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  endpoint,
                  category_hint,
                  video: {
                    url: data.video.url,
                    dataUrl: videoProcessed.dataUrl,
                    localPath: videoProcessed.localPath,
                    width: data.video.width,
                    height: data.video.height,
                  },
                  raw_output: data,
                  input_params,
                  download_path: DOWNLOAD_PATH,
                }, null, 2),
              },
            ],
          };
        }
      }

      // Fallback: return raw output
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              endpoint,
              category_hint,
              raw_output: result.data,
              input_params,
              note: "Raw output - model type not recognized for enhanced processing"
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Custom model execution failed for ${endpoint}: ${error}`);
    }
  }

  private setupConfigHandlers() {
    // Configuration handlers are handled differently in HTTP mode
    // The MCP protocol over HTTP will handle these automatically
  }

  private async findAvailablePort(startPort: number): Promise<number> {
    return new Promise((resolve) => {
      const testServer = createServer();
      testServer.listen(startPort, () => {
        const port = (testServer.address() as any)?.port || startPort;
        testServer.close(() => resolve(port));
      });
      testServer.on('error', () => {
        resolve(this.findAvailablePort(startPort + 1));
      });
    });
  }

  async run() {
    // Auto-detect HTTP mode: Smithery sets PORT, or explicit flags
    const useHttp = !!process.env.PORT || 
                   process.env.MCP_TRANSPORT === 'http' || 
                   process.argv.includes('--http');
    
    if (useHttp) {
      const basePort = Number(process.env.PORT) || 3000;
      
      // Use exact port if specified (Smithery), otherwise find available
      const targetPort = process.env.PORT ? 
        basePort : 
        await this.findAvailablePort(basePort);
      
      // HTTP transport for Smithery and testing
      const httpServer = createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }
        
        if (req.url === '/mcp' && req.method === 'GET') {
          // SSE endpoint for MCP communication
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });
          
          const transport = new SSEServerTransport('/mcp', res);
          await this.server.connect(transport);
          
          // Keep connection alive
          req.on('close', () => {
            transport.close?.();
          });
          
        } else if (req.url === '/mcp' && req.method === 'POST') {
          // Handle MCP messages
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', async () => {
            try {
              const message = JSON.parse(body);
              
              // Create a transport for this request
              const transport = new SSEServerTransport('/mcp', res);
              await this.server.connect(transport);
              
              // Handle the message
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'received' }));
              
            } catch (error) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
          });
          
        } else if (req.url === '/health' && req.method === 'GET') {
          // Health check endpoint
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', server: 'fal-image-video-mcp' }));
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      
      httpServer.listen(targetPort, () => {
        console.error(`FAL Image/Video MCP server running on HTTP port ${targetPort} at /mcp`);
      });
    } else {
      // Default stdio transport for Claude Desktop
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('FAL Image/Video MCP server running on stdio');
    }
  }
}

const server = new FalMcpServer();
server.run().catch(console.error);