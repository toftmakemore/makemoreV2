import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  process.env = { ...process.env, ...loadEnv(mode, process.cwd()) };

  return {
    plugins: [
      vue(),
      visualizer()
    ],
    define: {
      'process.env': process.env,
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false
    },
    build: {
      target: 'es2015',
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: true,
          drop_debugger: true
        }
      },
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor': ['vue', 'vue-router', 'vuex'],
            'firebase': ['firebase/app', 'firebase/auth', 'firebase/firestore']
          }
        }
      },
      chunkSizeWarningLimit: 600
    },
    optimizeDeps: {
      include: ['vue', 'vue-router', 'vuex']
    }
  };
});
