using System.Net.Http.Json;
using System.Text.Json;
namespace EduMaster.Core;

public sealed class GeminiVisualGenerator(HttpClient client)
{
    public const string Model="gemini-2.5-flash";
    public static string DisplayName(string model)=>model=="gemini-3.8-flash"?"Gemini 3.8 Flash":"Gemini 2.5 Flash";
    public async Task<string> ReadAsync(VisualPage page,string apiKey,CancellationToken token=default,string model=Model)
    {
        if(model is not("gemini-2.5-flash" or "gemini-3.8-flash"))throw new ArgumentException("Gemini 모델을 확인해 주세요.");
        if(string.IsNullOrWhiteSpace(apiKey))throw new InvalidOperationException("서버에 Gemini API 키가 없습니다.");
        if(page.Bytes.Length is <=0 or >FileImport.MaxBytes || page.MimeType is not("image/png" or "image/jpeg"))throw new ArgumentException("원본 이미지의 형식·크기를 확인해 주세요.");
        using var stream=typeof(GeminiVisualGenerator).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts.image-reader-v1.txt")!;
        using var reader=new StreamReader(stream);
        var prompt=await reader.ReadToEndAsync(token)+"\nJSON body의 문자열에는 문장·표 행·보기마다 실제 줄바꿈(\\n)을 넣으세요. Markdown 표의 한 행은 반드시 한 줄입니다. 화살표는 →, 곱셈은 ×로 적으세요. 표에 인쇄된 미지수와 필기로 적힌 계산값을 구분하여 필기는 [주석]에 적으세요. 물질량(mol)과 몰질량(g/mol)을 추측으로 바꾸지 말고 원본 글자를 확인하세요.";
        using var request=new HttpRequestMessage(HttpMethod.Post,$"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
        request.Headers.Add("x-goog-api-key",apiKey.Trim());
        var config=new Dictionary<string,object>{{"temperature",0},{"maxOutputTokens",8192},{"responseMimeType","application/json"},{"responseJsonSchema",new{type="object",properties=new{body=new{type="string"}},required=new[]{"body"}}}};
        if(model==Model)config["thinkingConfig"]=new{thinkingBudget=1024};
        request.Content=JsonContent.Create(new{contents=new[]{new{role="user",parts=new object[]{new{text=prompt},new{inlineData=new{mimeType=page.MimeType,data=Convert.ToBase64String(page.Bytes)}}}}},generationConfig=config});
        using var response=await SendWithRetryAsync(request,null,token);
        if(!response.IsSuccessStatusCode)throw new InvalidOperationException($"Gemini 원본 이미지 읽기 실패 ({(int)response.StatusCode})");
        var bytes=await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token),1024*1024,token);
        return ParseReading(bytes);
    }
    public static string ParseReading(byte[] bytes)
    {
        try{
            using var envelope=JsonDocument.Parse(bytes);var candidate=envelope.RootElement.GetProperty("candidates")[0];
            if(candidate.GetProperty("finishReason").GetString()!="STOP")throw new InvalidDataException("Gemini 이미지 판독이 완료되지 않았습니다. 잘린 본문은 사용하지 않습니다.");
            var text=string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray().Where(p=>p.TryGetProperty("text",out _)&&(!p.TryGetProperty("thought",out var thought)||thought.ValueKind!=JsonValueKind.True)).Select(p=>p.GetProperty("text").GetString()));
            using var document=JsonDocument.Parse(text);var body=document.RootElement.GetProperty("body").GetString()?.Trim()??"";
            if(body.Length is <8 or >12000 || body.Contains("[판독불가]"))throw new InvalidDataException("원본 이미지에서 읽지 못한 부분이 있습니다. 문제와 표가 함께 보이는 선명한 이미지를 넣어 주세요.");
            return LocalVisionReader.NormalizeMath(body);
        }catch(Exception e)when(e is JsonException or KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException){throw new InvalidDataException("Gemini 이미지 판독 응답을 읽지 못했습니다.",e);}
    }
    public async Task<SampleResult> GenerateAsync(ProblemDraft draft,string apiKey,IProgress<string>? progress=null,CancellationToken token=default,IReadOnlyList<VisualPage>? images=null,string model=Model)
    {
        draft.Validate();
        if(model is not("gemini-2.5-flash" or "gemini-3.8-flash"))throw new ArgumentException("Gemini 모델을 확인해 주세요.");
        if(string.IsNullOrWhiteSpace(apiKey))throw new InvalidOperationException("서버에 Gemini API 키가 없습니다.");
        if(images is {Count:>0}&&(images.Count>5||images.Sum(p=>(long)p.Bytes.Length)>FileImport.MaxBytes||images.Any(p=>p.Bytes.Length==0||p.MimeType is not("image/png" or "image/jpeg"))))throw new ArgumentException("원본 이미지의 형식·크기를 확인해 주세요.");
        var source=JsonSerializer.Serialize(new{inputFingerprint=draft.Fingerprint(),materialKind=draft.UseSolutionLogic?"problem-and-solution":draft.FromSolution?"solution":"problem",title=draft.Title,body=draft.Body,suppliedAnswer=draft.Answer,suppliedExplanation=draft.Explanation,suppliedSteps=draft.Steps,
            visualPolicy="원본 그림의 연결 관계와 내부 수치를 유지하고 그림 밖 조건·질문만 변형. 표는 수치 변형 가능. 원본 필기 정답을 새 조건으로 사용하지 않는다."});
        var parts=new List<object>{new{text=source}};
        if(images is not null)parts.AddRange(images.Select(p=>(object)new{inlineData=new{mimeType=p.MimeType,data=Convert.ToBase64String(p.Bytes)}}));
        using var request=new HttpRequestMessage(HttpMethod.Post,$"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
        request.Headers.Add("x-goog-api-key",apiKey.Trim());
        // The selected model constructs the variant for the supplied problem type.
        var generationConfig=new Dictionary<string,object>{{"temperature",0.0},{"maxOutputTokens",8192},{"responseMimeType","application/json"},{"responseJsonSchema",VariantResponse.LocalSchema(draft)}};
        if(model=="gemini-2.5-flash")generationConfig["thinkingConfig"]=new{thinkingBudget=1024};
        request.Content=JsonContent.Create(new{systemInstruction=new{parts=new[]{new{text=VariantResponse.LocalPrompt()}}},contents=new[]{new{role="user",parts}},generationConfig});
        progress?.Report("Gemini가 기준 자료와 원본 이미지로 문제 생성 중");
        using var response=await SendWithRetryAsync(request,progress,token);
        if(!response.IsSuccessStatusCode)throw new InvalidOperationException((int)response.StatusCode switch{401 or 403=>"Gemini 키 인증·권한을 확인해 주세요.",429=>"Gemini 호출 할당량·결제 한도를 확인해 주세요.",400 or 404=>"Gemini 모델 또는 입력 요청이 지원되지 않습니다.",500 or 502 or 503 or 504=>"Google Gemini 서버가 일시적인 과부하(503) 상태입니다. 잠시 후 다시 시도해 주세요.",_=>$"Gemini 요청 실패 ({(int)response.StatusCode})"});
        var bytes=await FileImport.ReadLimitedAsync(await response.Content.ReadAsStreamAsync(token),1024*1024,token);
        progress?.Report("Gemini 응답 형식·원문 연결·정답 검산");
        var result=ParseResponse(bytes,draft,model);
        if(ReactionMassCheck.Solve(result.Body) is not null)result=ReactionMassCheck.Verify(result);
        return result with{ImageInputCount=images?.Count??0,RuntimeModelId=model,
            Figures=images?.Select(p=>new PreservedFigure(p.Page,p.DataUrl,"기준 원본 이미지 · 새 조건은 변형 본문 참조")).ToArray()??[],
            VisualVerification=images is {Count:>0}?$"Gemini에 원본 이미지 {images.Count}장 직접 입력 · 그림 관계는 AI 초안이며 교사 검수 필요":"텍스트 자료 기반 생성"};
    }
    private async Task<HttpResponseMessage> SendWithRetryAsync(HttpRequestMessage template,IProgress<string>? progress,CancellationToken token)
    {
        var payload=await template.Content!.ReadAsByteArrayAsync(token);
        for(var attempt=0;;attempt++){
            using var request=new HttpRequestMessage(template.Method,template.RequestUri){Content=new ByteArrayContent(payload)};
            foreach(var header in template.Headers)request.Headers.TryAddWithoutValidation(header.Key,header.Value);
            request.Content.Headers.ContentType=new("application/json");
            var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,token);
            if((int)response.StatusCode is not(500 or 502 or 503 or 504)||attempt>=2)return response;
            response.Dispose();progress?.Report($"Gemini 서버 일시 오류 · 재시도 {attempt+1}/2");await Task.Delay(TimeSpan.FromSeconds(2*(attempt+1)),token);
        }
    }
    public static SampleResult ParseResponse(byte[] bytes,ProblemDraft draft,string model=Model)
    {
        try{
            using var envelope=JsonDocument.Parse(bytes);var root=envelope.RootElement;var candidate=root.GetProperty("candidates")[0];
            var finish=candidate.GetProperty("finishReason").GetString();
            if(finish!="STOP")throw new InvalidDataException(finish=="MAX_TOKENS"?"Gemini 출력 분량 한도에 도달했습니다. 잘린 결과는 표시하지 않습니다.":$"Gemini 답변이 완료되지 않았습니다 ({finish}). 잘리거나 차단된 답변은 표시하지 않습니다.");
            var text=string.Concat(candidate.GetProperty("content").GetProperty("parts").EnumerateArray().Where(p=>p.TryGetProperty("text",out _)&&(!p.TryGetProperty("thought",out var thought)||thought.ValueKind!=JsonValueKind.True)).Select(p=>p.GetProperty("text").GetString()));
            var localEnvelope=JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason="stop",message=new{content=text}}}});
            var result=LocalGemmaGenerator.ParseResponse(localEnvelope,draft,DisplayName(model),requireFingerprint:true);
            var usage=root.TryGetProperty("usageMetadata",out var u)&&u.TryGetProperty("totalTokenCount",out var total)?$"총 {total.GetInt32()} 토큰 · Gemini API 호출 · 비용 미산정":"Gemini API 호출 · 비용 미산정";
            return result with{Model=DisplayName(model),UsageSummary=usage,GenerationNotice="Gemini AI 초안 · 교사 확인 전"};
        }catch(Exception e)when(e is JsonException or KeyNotFoundException or InvalidOperationException or IndexOutOfRangeException){throw new InvalidDataException("Gemini 응답을 읽지 못했습니다.",e);}
    }
}
