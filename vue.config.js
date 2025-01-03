const path = require("path");
const webpack = require('webpack');
const TerserPlugin = require('terser-webpack-plugin');
const fs = require('fs-extra');

// Funktion til at kopiere dist til functions
async function copyDistToFunctions() {
  const sourcePath = path.resolve(__dirname, 'dist');
  const targetPath = path.resolve(__dirname, 'functions/dist');
  
  try {
    await fs.ensureDir(targetPath);
    await fs.copy(sourcePath, targetPath, {
      overwrite: true,
      preserveTimestamps: true
    });
    console.log('✓ Dist-mappe kopieret til functions/dist');
  } catch (error) {
    console.error('Fejl ved kopiering af dist-mappe:', error);
  }
}

module.exports = {
  lintOnSave: false,
  transpileDependencies: true,
  publicPath: "/",
  outputDir: "dist",
  filenameHashing: true,
  
  // Hook ind i build processen
  chainWebpack: config => {
    config.output
      .filename('[name].[hash].js')
      .chunkFilename('[name].[hash].js');
    
    if (process.env.NODE_ENV === 'development') {
      config.cache(false);
    }
    
    config.plugin('compression').use(require('compression-webpack-plugin'));
    
    config.performance
      .hints('warning')
      .maxEntrypointSize(400000)
      .maxAssetSize(300000);
    
    if (process.env.NODE_ENV === 'production') {
      config.optimization.minimizer('terser').tap(args => {
        args[0].terserOptions.compress.drop_console = true;
        args[0].terserOptions.compress.drop_debugger = true;
        return args;
      });
      
      // Kør kopieringen efter build er færdig
      process.on('exit', () => {
        copyDistToFunctions();
      });
    }
  },
  
  configureWebpack: {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@components": path.resolve(__dirname, "src/components"),
        "@views": path.resolve(__dirname, "src/views"),
        "@services": path.resolve(__dirname, "src/services"),
      },
    },
    plugins: [
      new webpack.DefinePlugin({
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false'
      })
    ],
    devtool: 'source-map',
    performance: {
      hints: false
    },
    optimization: {
      minimize: process.env.NODE_ENV === 'production',
      minimizer: [
        new TerserPlugin({
          parallel: true,
          terserOptions: {
            compress: {
              warnings: false,
              drop_console: true,
              drop_debugger: true,
              pure_funcs: ['console.log']
            },
            format: {
              comments: false,
            },
          },
          extractComments: false,
        }),
      ],
      moduleIds: 'deterministic',
      runtimeChunk: 'single',
      splitChunks: {
        chunks: 'all',
        maxInitialRequests: Infinity,
        minSize: 0,
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name(module) {
              if (!module.context) {
                return 'vendor';
              }
              
              const match = module.context.match(
                /[\\/]node_modules[\\/](.*?)([\\/]|$)/
              );
              
              if (!match || !match[1]) {
                return 'vendor';
              }
              
              const packageName = match[1];
              return `vendor.${packageName.replace('@', '')}`;
            },
          },
        },
      }
    },
    cache: {
      type: 'filesystem',
      buildDependencies: {
        config: [__filename]
      }
    }
  },
  productionSourceMap: process.env.NODE_ENV === 'production'
};
