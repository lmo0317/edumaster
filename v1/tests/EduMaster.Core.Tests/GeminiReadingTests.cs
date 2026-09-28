using System.Net;
using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;
public class GeminiReadingTests
{
    static byte[] Response(string body,string finish="STOP")=>JsonSerializer.SerializeToUtf8Bytes(new{candidates=new[]{new{finishReason=finish,content=new{parts=new[]{new{text=JsonSerializer.Serialize(new{body})}}}}}});
    [Fact]public void RejectsPartialTranscription()=>Assert.Throws<InvalidDataException>(()=>GeminiVisualGenerator.ParseReading(Response("원본 조건과 표의 본문입니다.","MAX_TOKENS")));
    [Fact]public void RejectsUnreadableSource()=>Assert.Throws<InvalidDataException>(()=>GeminiVisualGenerator.ParseReading(Response("실험 표 [판독불가]와 질문")));
    [Fact]public void PreservesPhysicalQuantityAndRows(){var body="C의 몰질량은?\n| I | 5w | 5w | A w | x |\n| II | 4w | 6w | A 2w | 18 |";Assert.Equal(body,GeminiVisualGenerator.ParseReading(Response(body)));}
    sealed class Handler:HttpMessageHandler{
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken token){
            Assert.Contains("gemini-2.5-flash",request.RequestUri!.AbsolutePath);Assert.Equal("",request.RequestUri.Query);
            Assert.Equal("test-key",request.Headers.GetValues("x-goog-api-key").Single());
            using var json=JsonDocument.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.Equal("AQID",json.RootElement.GetProperty("contents")[0].GetProperty("parts")[1].GetProperty("inlineData").GetProperty("data").GetString());
            return new(HttpStatusCode.OK){Content=new ByteArrayContent(Response("원본 반응식과 실험 표의 본문입니다."))};
        }
    }
    [Fact]public async Task ReadsOriginalWithSelectedCloudModel(){using var client=new HttpClient(new Handler());var body=await new GeminiVisualGenerator(client).ReadAsync(new([1,2,3],"image/png",1),"test-key");Assert.Contains("실험 표",body);}
}
