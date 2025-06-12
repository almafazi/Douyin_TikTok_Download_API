import SsstikFallbackDownloader from '../ssstik-fallback.js';

// Quick test function
async function quickTest() {
  console.log('🚀 Quick Ssstik Fallback Test\n');

  const fallback = new SsstikFallbackDownloader({
    proxy: process.env.SSSTIK_PROXY || null,
    timeout: 30000,
    locale: 'id'
  });

  // Test URLs
  const testUrls = [
    'https://vt.tiktok.com/ZSkmh5V1t/', // Video
  ];

  for (const url of testUrls) {
    console.log(`🧪 Testing: ${url}`);
    console.log('⏳ Processing...');
    
    try {
      const startTime = Date.now();
      const result = await fallback.fetchTikTokData(url, true);
      const duration = Date.now() - startTime;
      
      console.log(`✅ Success! (${duration}ms)`);
      console.log(`📋 Author: ${result.data?.author?.nickname || 'Unknown'}`);
      console.log(`📝 Type: ${result.data?.type || 'Unknown'}`);
      
      if (result.data?.type === 'image') {
        const imageUrls = result.data.image_data?.no_watermark_image_list || [];
        console.log(`🖼️  Images: ${imageUrls.length} found`);
        
        imageUrls.forEach((imageUrl, index) => {
          console.log(`   📷 Image ${index + 1}: ${imageUrl}`);
        });
      }
      
      if (result.data?.type === 'video') {
        const videoData = result.data.video_data || {};
        console.log(`🎥 Video URLs:`);
        
        if (videoData.nwm_video_url) {
          console.log(`   🎬 No Watermark: ${videoData.nwm_video_url}`);
        }
        
        if (videoData.nwm_video_url_HQ) {
          console.log(`   🎬 No Watermark HD: ${videoData.nwm_video_url_HQ}`);
        }
        
        if (videoData.wm_video_url) {
          console.log(`   🎬 With Watermark: ${videoData.wm_video_url}`);
        }
        
        if (videoData.wm_video_url_HQ) {
          console.log(`   🎬 With Watermark HD: ${videoData.wm_video_url_HQ}`);
        }
        
        if (!videoData.nwm_video_url && !videoData.nwm_video_url_HQ && !videoData.wm_video_url && !videoData.wm_video_url_HQ) {
          console.log(`   ❌ No video URLs found`);
        }
      }
      
      // Audio URL
      const audioUrl = result.data?.music?.play_url?.url;
      if (audioUrl) {
        console.log(`🎵 Audio: ${audioUrl}`);
      } else {
        console.log(`🎵 Audio: Not found`);
      }
      
      // Show raw data structure for debugging (optional)
      if (process.env.DEBUG) {
        console.log('\n🔍 Raw Response Data:');
        console.log(JSON.stringify(result, null, 2));
      }
      
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }
    
    console.log('─'.repeat(50));
  }

  console.log('🏁 Quick test completed!');
  console.log('\n💡 Tips:');
  console.log('- Run with DEBUG=1 to see raw response data');
  console.log('- Copy URLs above to test downloads');
  console.log('- Use "node test-ssstik-fallback.js" for full testing');
}

// Run the test
quickTest().catch(console.error);