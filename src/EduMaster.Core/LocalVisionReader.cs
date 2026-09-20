using System.Net.Http.Json;
using System.Text.Json;
namespace EduMaster.Core;

public sealed class LocalVisionReader(HttpClient client)
{
    public const string Endpoint="http://127.0.0.1:8091/v1/";
    public const string Model="edumaster-ocr-qwen3vl-4b";
    public const string ReadMethod="로컬 Qwen3-VL 이미지 인식";
    public async Task<string> ReadAsync(byte[] image,string mime,CancellationToken token=default)
        =>NormalizeMath(await RequestAsync(image,mime,Prompt,4096,token));
    public async Task<ProblemSolutionMaterial> ReadMaterialAsync(VisualPage page,CancellationToken token=default,string? endpoint=null,string? model=null,IReadOnlyList<VisualPage>? views=null)
    {
        var schema=new{type="object",properties=new{
            body=new{type="string",maxLength=1800},answer=new{type="string",maxLength=100},explanation=new{type="string",maxLength=650},
            steps=new{type="array",minItems=ProblemDraft.MinLogicSteps,maxItems=ProblemDraft.MaxLogicSteps,items=new{type="string",maxLength=3000}},
            uncertainties=new{type="array",maxItems=20,items=new{type="string"}}},required=new[]{"body","answer","explanation","steps","uncertainties"}};
        if(endpoint is not null)endpoint=LocalGemmaGenerator.Endpoint(endpoint).AbsoluteUri;
        var text=await RequestAsync(page.Bytes,page.MimeType,Resource("problem-solution-reader-v1"),2500,token,schema,endpoint,model,views);
        try{return ProblemSolutionMaterial.Parse(text);}catch(InvalidDataException e){e.Data["MaterialReply"]=text;throw;}
    }
    public async Task<VisualUnderstanding> UnderstandAsync(VisualPage page,string body,CancellationToken token=default)
        =>VisualUnderstanding.Parse(await RequestAsync(page.Bytes,page.MimeType,Resource("visual-understanding-v1")+"\n사용자가 확인한 본문(원본과 다르면 uncertainties에 기록):\n"+body,2500,token,UnderstandingSchema()));
    public async Task VerifyAsync(VisualPage page,VisualUnderstanding context,SampleResult result,CancellationToken token=default)
    {
        var prompt=Resource("visual-verify-v1")+"\n"+JsonSerializer.Serialize(new{visualContext=context,variant=new{result.Body,result.Choices,result.Answer,result.Explanation,result.Steps}},new JsonSerializerOptions{Encoder=System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping});
        var text=await RequestAsync(page.Bytes,page.MimeType,prompt,1200,token,new{type="object",properties=new{consistent=new{type="boolean"},message=new{type="string"},uncertainties=new{type="array",items=new{type="string"},maxItems=10}},required=new[]{"consistent","message","uncertainties"}});
        ValidateVerification(text);
    }
    public static void ValidateVerification(string text)
    {
        try{using var json=JsonDocument.Parse(text);var root=json.RootElement;
            if(!root.GetProperty("consistent").GetBoolean() || root.GetProperty("uncertainties").GetArrayLength()!=0)throw new InvalidDataException("원본 그림과 변형 문제의 일치를 확인하지 못했습니다: "+root.GetProperty("message").GetString());
        }catch(Exception e) when(e is JsonException or InvalidOperationException or KeyNotFoundException){throw new InvalidDataException("그림 대조 응답 형식이 잘못되었습니다.",e);}
    }
    private static string Resource(string name){using var s=typeof(LocalVisionReader).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts."+name+".txt")!;using var r=new StreamReader(s);return r.ReadToEnd();}
    private static object UnderstandingSchema()=>new{type="object",properties=new{
        kind=new{type="string",@enum=new[]{"text","table","graph","molecule","diagram"}},summary=new{type="string"},
        nodes=new{type="array",maxItems=100,items=new{type="object",properties=new{id=new{type="string"},label=new{type="string"}},required=new[]{"id","label"}}},
        edges=new{type="array",maxItems=150,items=new{type="object",properties=new{from=new{type="string"},to=new{type="string"},relation=new{type="string"}},required=new[]{"from","to","relation"}}},
        constraints=new{type="array",maxItems=12,items=new{type="string"}},uncertainties=new{type="array",maxItems=30,items=new{type="string"}}},required=new[]{"kind","summary","nodes","edges","constraints","uncertainties"}};
    public const string PromptVersion="image-reader-v1";
    private static string Prompt { get { using var stream=typeof(LocalVisionReader).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts.image-reader-v1.txt")!;using var reader=new StreamReader(stream);return reader.ReadToEnd(); } }
    public static string NormalizeMath(string text)
    {
        text=System.Text.RegularExpressions.Regex.Replace(text,@"\\(?:text|mathrm|mathbf)\{([^{}]*)\}","$1");
        for(var i=0;i<4;i++)text=System.Text.RegularExpressions.Regex.Replace(text,@"\\frac\{([^{}]*)\}\{([^{}]*)\}","($1)/($2)");
        return text.Replace("\\longrightarrow","→").Replace("\\rightarrow","→").Replace("->","→").Replace("\\times","×").Replace("\\left","").Replace("\\right","").Replace("$","").Trim();
    }
    private async Task<string> RequestAsync(byte[] image,string mime,string prompt,int limit,CancellationToken token,object? schema=null,string? endpoint=null,string? model=null,IReadOnlyList<VisualPage>? views=null)
    {
        if(image.Length is <=0 or >FileImport.MaxBytes || mime is not("image/png" or "image/jpeg"))throw new ArgumentException("인식할 PNG 또는 JPG 이미지를 확인해 주세요.");
        var parts=new List<object>{new{type="text",text=prompt}};
        foreach(var p in views??[new VisualPage(image,mime,1)]){var label=ProblemSolutionMaterial.ViewLabel(p);if(label.Length>0)parts.Add(new{type="text",text=label});parts.Add(new{type="image_url",image_url=new{url=p.DataUrl}});}
        var body=new{
            model=model??Model,
            messages=new[]{new{role="user",content=parts.ToArray()}},
            temperature=0,max_tokens=limit,stream=false,reasoning_effort="low",chat_template_kwargs=new{enable_thinking=false},
            response_format=schema is null?null:new{type="json_object",schema}
        };
        HttpResponseMessage response;
        try{response=await client.PostAsJsonAsync((endpoint??Endpoint)+"chat/completions",body,token);}
        catch(HttpRequestException e){throw new InvalidOperationException("로컬 이미지 모델에 연결하지 못했습니다. 웹 실행 도구로 이미지 모델을 실행해 주세요.",e);}
        using var disposeResponse=response;
        if(!response.IsSuccessStatusCode)throw new InvalidOperationException($"로컬 이미지 인식 요청 실패 ({(int)response.StatusCode}) · 더 선명한 문제 한 개의 이미지를 선택해 주세요.");
        var bytes=await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token),1024*1024,token);
        return Parse(bytes);
    }
    public static string Parse(byte[] bytes)
    {
        try{
            using var document=JsonDocument.Parse(bytes);var choice=document.RootElement.GetProperty("choices")[0];
            if(choice.GetProperty("finish_reason").GetString()!="stop")throw new InvalidDataException("이미지 인식 답변이 잘렸습니다. 문제 부분만 잘라서 다시 넣어 주세요.");
            var text=choice.GetProperty("message").GetProperty("content").GetString()?.Trim()??"";
            if(text.Length<8||text.Length>12000)throw new InvalidDataException("읽을 수 있는 문제 본문이 부족하거나 너무 깁니다. 문제 한 개의 선명한 파일을 선택해 주세요.");
            return text;
        }catch(Exception e) when(e is JsonException or InvalidOperationException or KeyNotFoundException or IndexOutOfRangeException){throw new InvalidDataException("이미지 인식 응답을 읽지 못했습니다. 다시 넣어 주세요.",e);}
    }
}
