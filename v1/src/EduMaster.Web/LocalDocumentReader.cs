using System.Diagnostics;
using EduMaster.Core;

namespace EduMaster.App;

// Cross-platform web reader. Images are kept byte-for-byte so the selected
// cloud/local vision model sees the original pixels. PDF pages are rendered by
// Poppler, which is installed on the always-on Linux host.
internal static class LocalDocumentReader
{
    internal static async Task<string> ReadAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(300)};
        var reader=new LocalVisionReader(client);var texts=new List<string>();
        foreach(var page in await RenderAsync(source,directory,token))texts.Add($"[페이지 {page.Page}]\n"+await reader.ReadAsync(page.Bytes,page.MimeType,token));
        var text=string.Join("\n\n",texts).Trim();
        if(text.Length<8)throw new InvalidOperationException("사진에서 글자를 충분히 읽지 못했습니다. 더 선명한 파일을 선택하거나 문제 본문을 직접 입력해 주세요.");
        if(text.Length>12000)throw new ArgumentException("인식 본문이 12,000자를 넘었습니다. 문제 부분만 따로 넣어 주세요.");
        return text;
    }

    internal static async Task<VisualPage[]> RenderAsync(ImportedSource source,string directory,CancellationToken token=default)
    {
        var sourcePath=FileImport.SourcePath(source,directory);
        if(source.MimeType is "image/png" or "image/jpeg")return [new(await FileImport.ReadSourceAsync(source,directory,token),source.MimeType,1)];
        if(source.MimeType!="application/pdf")return [];
        var work=Path.Combine(directory,"pdf-render-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(work);
        try{
            var pages=await PageCountAsync(sourcePath,token);if(pages>5)throw new ArgumentException("PDF는 5페이지까지 지원합니다. 문제 한 개만 별도 저장해 주세요.");
            var prefix=Path.Combine(work,"page");
            await RunAsync("pdftoppm",["-f","1","-l",Math.Min(5,pages).ToString(),"-r","180","-png",sourcePath,prefix],token);
            var files=Directory.EnumerateFiles(work,"page-*.png").OrderBy(path=>path,StringComparer.Ordinal).ToArray();
            if(files.Length==0)throw new InvalidOperationException("PDF 페이지를 이미지로 변환하지 못했습니다.");
            var result=new List<VisualPage>();for(var i=0;i<files.Length;i++)result.Add(new(await File.ReadAllBytesAsync(files[i],token),"image/png",i+1));
            if(result.Sum(page=>(long)page.Bytes.Length)>FileImport.MaxBytes)throw new ArgumentException("렌더링 이미지가 10MB를 넘습니다. 문제 한 개만 넣어 주세요.");
            return result.ToArray();
        }finally{try{Directory.Delete(work,true);}catch{}}
    }

    // Preserve the uploaded page for the report, but give the vision model
    // separate, readable regions when a textbook page has a clear white gutter.
    internal static async Task<VisualPage[]> MaterialViewsAsync(VisualPage page,CancellationToken token)
    {
        if(page.MimeType is not("image/png" or "image/jpeg"))return [page];
        var path=Path.Combine(Path.GetTempPath(),"edumaster-material-"+Guid.NewGuid().ToString("N")+(page.MimeType=="image/png"?".png":".jpg"));
        await File.WriteAllBytesAsync(path,page.Bytes,token);
        try{
            var size=(await RunAsync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=s=x:p=0",path],token)).Trim().Split('x');
            if(size.Length!=2||!int.TryParse(size[0],out var width)||!int.TryParse(size[1],out var height)||width<500||height<width*1.2||width>2500||height>3000)return [page];
            var pixels=await RunBinaryAsync("ffmpeg",["-v","error","-i",path,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","pipe:1"],token);
            if(pixels.Length!=(long)width*height*3)return [page];
            bool White(int x,int y){var i=(y*width+x)*3;return pixels[i]>245&&pixels[i+1]>245&&pixels[i+2]>245;}
            bool Ink(int x,int y){var i=(y*width+x)*3;return pixels[i]<210||pixels[i+1]<210||pixels[i+2]<210;}
            bool Cyan(int x,int y){var i=(y*width+x)*3;return pixels[i+2]>pixels[i]+20&&pixels[i+1]>pixels[i]+10&&pixels[i]>70;}
            var top=(int)(height*.08);var bottom=(int)(height*.95);var sampledRows=0;var leftRows=0;var rightRows=0;
            for(var y=top;y<bottom;y+=3){var leftInk=0;var rightInk=0;sampledRows++;
                for(var x=width/20;x<width*19/20;x+=2){if(!Ink(x,y))continue;if(x<width/2)leftInk++;else rightInk++;}
                if(leftInk>=10)leftRows++;if(rightInk>=10)rightRows++;
            }
            // A printed STEP can end low in the left column and continue at the
            // top of a much longer right column. Sparse left ink is still a column.
            var minimumRows=page.MaterialRole=="solution"?Math.Max(12,sampledRows*.06):sampledRows*.25;
            if(leftRows<minimumRows||rightRows<minimumRows)return [page];
            var gutter=0;var bestScore=0d;
            for(var x=(int)(width*.4);x<width*.6;x++){var white=0;
                for(var y=top;y<bottom;y++)for(var dx=-3;dx<=3;dx++)if(White(x+dx,y))white++;
                var score=white/(double)((bottom-top)*7);
                if(score>bestScore||score==bestScore&&Math.Abs(x-width/2)<Math.Abs(gutter-width/2)){gutter=x;bestScore=score;}
            }
            if(bestScore<.98)return [page];
            var frameBottom=0;
            for(var y=(int)(height*.18);y<height*.7;y++){var blue=0;for(var x=(int)(gutter*.03);x<gutter*.96;x++)if(Cyan(x,y))blue++;if(blue>gutter*.7)frameBottom=y;}
            if(frameBottom>0){
                double VerticalScore(int start,int end){var score=0d;for(var x=start;x<end;x++){var count=0;for(var y=(int)(height*.07);y<frameBottom-6;y++)if(Cyan(x,y))count++;score=Math.Max(score,count/(double)(frameBottom-6-(int)(height*.07)));}return score;}
                if(VerticalScore(0,(int)(gutter*.08))<.7||VerticalScore((int)(gutter*.85),gutter)<.7)frameBottom=0;
            }
            var regions=new List<(int X,int Y,int Width,int Height,string Role)>();
            if(frameBottom>0){var cut=Math.Min(frameBottom+6,height-1);regions.Add((0,0,gutter,cut,"question"));regions.Add((0,cut,gutter,height-cut,"solution"));}
            else regions.Add((0,0,gutter,height,page.MaterialRole));
            regions.Add((gutter,0,width-gutter,height,frameBottom>0?"solution":page.MaterialRole));
            var views=new List<VisualPage>();
            foreach(var region in regions){
                var scale=Math.Min(2d,1700d/Math.Max(region.Width,region.Height));
                var filter=$"crop={region.Width}:{region.Height}:{region.X}:{region.Y},scale={Math.Max(1,(int)(region.Width*scale))}:{Math.Max(1,(int)(region.Height*scale))}:flags=lanczos";
                var bytes=await RunBinaryAsync("ffmpeg",["-v","error","-i",path,"-vf",filter,"-frames:v","1","-f","image2pipe","-vcodec","png","pipe:1"],token);
                var note=region.Role=="solution"
                    ?region.X==0?"해설의 왼쪽 열입니다. 마지막 STEP은 오른쪽 열 첫 문단으로 이어질 수 있습니다."
                        :"해설의 오른쪽 열입니다. 첫 STEP 제목 위의 문단은 왼쪽 열 마지막 STEP의 이어지는 풀이입니다. 제목이 없다고 생략하지 말고 앞 STEP에 연결하세요."
                    :"";
                views.Add(new(bytes,"image/png",page.Page){MaterialRole=region.Role,ReadingRegion=note});
            }
            return views.ToArray();
        }finally{try{File.Delete(path);}catch{}}
    }

    // Long, narrow worked solutions lose small equations when the vision model
    // reduces the entire image to one thumbnail. Original report images remain
    // byte-for-byte intact; these overlapping views are used only for reading.
    internal static async Task<VisualPage[]> ReadableMaterialViewsAsync(VisualPage[] pages,CancellationToken token)
    {
        var result=new List<VisualPage>();
        foreach(var page in pages){
            var path=Path.Combine(Path.GetTempPath(),"edumaster-readable-"+Guid.NewGuid().ToString("N")+(page.MimeType=="image/png"?".png":".jpg"));
            await File.WriteAllBytesAsync(path,page.Bytes,token);
            try{
                var size=(await RunAsync("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","csv=s=x:p=0",path],token)).Trim().Split('x');
                if(size.Length!=2||!int.TryParse(size[0],out var width)||!int.TryParse(size[1],out var height)||width<=0||height<=0){result.Add(page);continue;}
                var tileHeight=page.MaterialRole=="question"&&height>width*1.6?Math.Max(300,(int)(width*1.1))
                    :page.MaterialRole=="solution"&&height>width*2.4?Math.Max(300,(int)(width*1.65)):height;
                var overlap=tileHeight==height?0:Math.Max(30,tileHeight/12);
                // Keep a whole-page overview for counting printed STEP headings.
                if(tileHeight<height)result.Add(page);
                for(var y=0;y<height;){
                    var h=Math.Min(tileHeight,height-y);
                    var factor=Math.Min(4d,Math.Min(1100d/width,1700d/h));
                    if(factor<=1&&tileHeight==height){result.Add(page);break;}
                    var filter=$"crop={width}:{h}:0:{y},scale={Math.Max(1,(int)(width*factor))}:{Math.Max(1,(int)(h*factor))}:flags=lanczos";
                    var bytes=await RunBinaryAsync("ffmpeg",["-v","error","-i",path,"-vf",filter,"-frames:v","1","-f","image2pipe","-vcodec","png","pipe:1"],token);
                    result.Add(new(bytes,"image/png",page.Page){MaterialRole=page.MaterialRole,ReadingRegion=page.ReadingRegion});
                    if(page.MaterialRole=="question"&&Environment.GetEnvironmentVariable("EDUMASTER_EXPERIMENTAL_PRINT_VIEWS")=="1"){
                        // A supplementary reading view, never a replacement for original pixels.
                        // All coloured printed diagrams remain available in the adjacent original.
                        var colour="gt(max(max(r(X,Y),g(X,Y)),b(X,Y))-min(min(r(X,Y),g(X,Y)),b(X,Y)),45)";
                        var printFilter=filter+$",geq=r='if({colour},255,r(X,Y))':g='if({colour},255,g(X,Y))':b='if({colour},255,b(X,Y))'";
                        var printBytes=await RunBinaryAsync("ffmpeg",["-v","error","-i",path,"-vf",printFilter,"-frames:v","1","-f","image2pipe","-vcodec","png","pipe:1"],token);
                        result.Add(new(printBytes,"image/png",page.Page){MaterialRole="question-print"});
                    }
                    if(y+h>=height)break;
                    y+=tileHeight-overlap;
                }
            }finally{try{File.Delete(path);}catch{}}
        }
        return result.ToArray();
    }

    private static async Task<byte[]> RunBinaryAsync(string file,IEnumerable<string> arguments,CancellationToken token)
    {
        var start=new ProcessStartInfo(file){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var value in arguments)start.ArgumentList.Add(value);
        using var process=Process.Start(start)??throw new InvalidOperationException(file+" 실행 파일을 찾지 못했습니다.");
        var stderr=process.StandardError.ReadToEndAsync(token);using var output=new MemoryStream();await process.StandardOutput.BaseStream.CopyToAsync(output,token);await process.WaitForExitAsync(token);
        if(process.ExitCode!=0)throw new InvalidDataException("문제·풀이 이미지 영역을 분리하지 못했습니다. "+(await stderr).Trim());
        return output.ToArray();
    }

    private static async Task<int> PageCountAsync(string path,CancellationToken token)
    {
        var output=await RunAsync("pdfinfo",[path],token);var line=output.Split('\n').FirstOrDefault(value=>value.StartsWith("Pages:",StringComparison.OrdinalIgnoreCase));
        return line is not null&&int.TryParse(line.Split(':',2)[1].Trim(),out var count)&&count>0?count:throw new InvalidDataException("PDF 페이지 수를 확인하지 못했습니다.");
    }

    private static async Task<string> RunAsync(string file,IEnumerable<string> arguments,CancellationToken token)
    {
        var start=new ProcessStartInfo(file){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};foreach(var value in arguments)start.ArgumentList.Add(value);
        using var process=Process.Start(start)??throw new InvalidOperationException(file+" 실행 파일을 찾지 못했습니다.");
        var stdout=process.StandardOutput.ReadToEndAsync(token);var stderr=process.StandardError.ReadToEndAsync(token);await process.WaitForExitAsync(token);
        if(process.ExitCode!=0)throw new InvalidOperationException("문서 이미지 변환에 실패했습니다. "+(await stderr).Trim());return await stdout;
    }
}
