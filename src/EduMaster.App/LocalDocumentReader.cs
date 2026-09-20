using System.IO;
using Windows.Data.Pdf;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using EduMaster.Core;
namespace EduMaster.App;

internal static class LocalDocumentReader
{
    internal static async Task<string> ReadAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        using var client=new System.Net.Http.HttpClient(new System.Net.Http.HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(300)};
        var reader=new LocalVisionReader(client);
        var texts=new List<string>();
        foreach(var page in await RenderAsync(source,directory,token))
            texts.Add($"[페이지 {page.Page}]\n"+await reader.ReadAsync(page.Bytes,page.MimeType,token));
        var text=string.Join("\n\n",texts).Trim();
        if(string.IsNullOrWhiteSpace(text)||text.Length<8) throw new InvalidOperationException("사진에서 글자를 충분히 읽지 못했습니다. 더 선명한 파일을 선택하거나 문제 본문을 직접 입력해 주세요.");
        if(text.Length>12000) throw new ArgumentException("인식 본문이 12,000자를 넘었습니다. 문제 부분만 따로 넣어 주세요.");
        return text;
    }
    internal static async Task<VisualPage[]> RenderAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        var bytes=await FileImport.ReadSourceAsync(source,directory,token);
        using var stream=await Stream(bytes);var pages=new List<VisualPage>();
        if(source.MimeType=="application/pdf")
        {
            var document=await PdfDocument.LoadFromStreamAsync(stream).AsTask(token);
            if(document.PageCount>5)throw new ArgumentException("PDF는 5페이지까지 지원합니다. 문제 한 개만 별도 저장해 주세요.");
            for(uint i=0;i<document.PageCount;i++)
            {
                token.ThrowIfCancellationRequested();using var page=document.GetPage(i);using var rendered=new InMemoryRandomAccessStream();
                var scale=Math.Min(1700/page.Size.Width,1700/page.Size.Height);
                await page.RenderToStreamAsync(rendered,new PdfPageRenderOptions{DestinationWidth=(uint)(page.Size.Width*scale),DestinationHeight=(uint)(page.Size.Height*scale)}).AsTask(token);
                rendered.Seek(0);pages.Add(new(await Encode(rendered,token),"image/png",(int)i+1));
            }
        }
        else pages.Add(new(await Encode(stream,token),"image/png",1));
        if(pages.Sum(p=>(long)p.Bytes.Length)>FileImport.MaxBytes)throw new ArgumentException("렌더링 이미지가 10MB를 넘습니다. 문제 한 개만 넣어 주세요.");
        return pages.ToArray();
    }
    private static async Task<InMemoryRandomAccessStream> Stream(byte[] bytes)
    {
        var stream=new InMemoryRandomAccessStream(); using var writer=new DataWriter(stream.GetOutputStreamAt(0));
        writer.WriteBytes(bytes); await writer.StoreAsync(); writer.DetachStream(); stream.Seek(0); return stream;
    }
    // A wide blank gutter identifies two-column textbook pages. Preserve source
    // pixels; give the reader separate columns instead of shrinking dense text.
    internal static async Task<VisualPage[]> MaterialViewsAsync(VisualPage page,CancellationToken token)
    {
        using var stream=await Stream(page.Bytes);var decoder=await BitmapDecoder.CreateAsync(stream).AsTask(token);
        var width=(int)decoder.PixelWidth;var height=(int)decoder.PixelHeight;
        if(width<300||height<width*1.2)return [page];
        var pixels=(await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8,BitmapAlphaMode.Ignore,new BitmapTransform(),ExifOrientationMode.IgnoreExifOrientation,ColorManagementMode.DoNotColorManage).AsTask(token)).DetachPixelData();
        var top=(int)(height*.08);var bottom=(int)(height*.95);var best=0;var bestScore=0d;
        var leftRows=0;var rightRows=0;var sampledRows=0;
        for(var y=top;y<bottom;y+=3){
            var leftInk=0;var rightInk=0;sampledRows++;
            for(var x=width/20;x<width*19/20;x+=2){var i=(y*width+x)*4;if(pixels[i]<210||pixels[i+1]<210||pixels[i+2]<210){if(x<width/2)leftInk++;else rightInk++;}}
            if(leftInk>=10)leftRows++;if(rightInk>=10)rightRows++;
        }
        if(leftRows<sampledRows*.25||rightRows<sampledRows*.25)return [page];
        for(var x=(int)(width*.4);x<width*.6;x++){
            var white=0;for(var y=top;y<bottom;y++)for(var dx=-3;dx<=3;dx++){var i=(y*width+x+dx)*4;if(pixels[i]>245&&pixels[i+1]>245&&pixels[i+2]>245)white++;}
            var score=white/(double)((bottom-top)*7);if(score>bestScore||score==bestScore&&Math.Abs(x-width/2)<Math.Abs(best-width/2)){best=x;bestScore=score;}
        }
        if(bestScore<.985)return [page];
        // Split a clearly closed cyan question frame before reading the adjacent
        // worked solution. No question/solution boundary is guessed on plain pages.
        bool Cyan(int x,int y){var i=(y*width+x)*4;return pixels[i]>pixels[i+2]+20&&pixels[i+1]>pixels[i+2]+10&&pixels[i+2]>70;}
        var frameBottom=0;
        for(var y=(int)(height*.18);y<height*.7;y++){
            var blue=0;for(var x=(int)(best*.03);x<best*.96;x++)if(Cyan(x,y))blue++;
            if(blue>best*.7)frameBottom=y;
        }
        if(frameBottom>0){
            double VerticalScore(int start,int end){var score=0d;for(var x=start;x<end;x++){var count=0;for(var y=(int)(height*.07);y<frameBottom-6;y++)if(Cyan(x,y))count++;score=Math.Max(score,count/(double)(frameBottom-6-(int)(height*.07)));}return score;}
            if(VerticalScore(0,(int)(best*.08))<.7||VerticalScore((int)(best*.85),best)<.7)frameBottom=0;
        }
        var regions=new List<(BitmapBounds Bounds,string Role)>();
        if(frameBottom>0){var cut=(uint)Math.Min(frameBottom+6,height-1);regions.Add((new(){X=0,Y=0,Width=(uint)best,Height=cut},"question"));regions.Add((new(){X=0,Y=cut,Width=(uint)best,Height=(uint)height-cut},"solution"));}
        else regions.Add((new(){X=0,Y=0,Width=(uint)best,Height=(uint)height},""));
        regions.Add((new(){X=(uint)best,Y=0,Width=(uint)(width-best),Height=(uint)height},frameBottom>0?"solution":""));
        var views=new List<VisualPage>();
        foreach(var region in regions){var bounds=region.Bounds;
            using var bitmap=await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8,BitmapAlphaMode.Premultiplied,new BitmapTransform{Bounds=bounds},ExifOrientationMode.IgnoreExifOrientation,ColorManagementMode.DoNotColorManage).AsTask(token);
            using var encoded=new InMemoryRandomAccessStream();var encoder=await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId,encoded).AsTask(token);encoder.SetSoftwareBitmap(bitmap);await encoder.FlushAsync().AsTask(token);
            encoded.Seek(0);using var input=new DataReader(encoded.GetInputStreamAt(0));await input.LoadAsync((uint)encoded.Size).AsTask(token);var bytes=new byte[encoded.Size];input.ReadBytes(bytes);views.Add(new(bytes,"image/png",page.Page){MaterialRole=region.Role});
        }
        return views.ToArray();
    }
    private static async Task<byte[]> Encode(IRandomAccessStream stream,CancellationToken token)
    {
        var decoder=await BitmapDecoder.CreateAsync(stream).AsTask(token);
        var scale=Math.Min(3,Math.Min(1700/(double)decoder.PixelWidth,1700/(double)decoder.PixelHeight));
        using var bitmap=await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8,BitmapAlphaMode.Premultiplied,
            new BitmapTransform{ScaledWidth=(uint)(decoder.PixelWidth*scale),ScaledHeight=(uint)(decoder.PixelHeight*scale)},ExifOrientationMode.RespectExifOrientation,ColorManagementMode.DoNotColorManage).AsTask(token);
        using var encoded=new InMemoryRandomAccessStream();
        var encoder=await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId,encoded).AsTask(token);
        encoder.SetSoftwareBitmap(bitmap);await encoder.FlushAsync().AsTask(token);
        encoded.Seek(0);using var input=new DataReader(encoded.GetInputStreamAt(0));
        await input.LoadAsync((uint)encoded.Size).AsTask(token);var image=new byte[encoded.Size];input.ReadBytes(image);
        return image;
    }
}
