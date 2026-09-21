using System.Text.Json;
namespace EduMaster.Core;

public static class VariantResponse
{
    public const string PromptVersion = "local-variant-v16-detailed-solution-chemistry-atom-count";
    public static string LocalPrompt()
    {
        using var stream=typeof(VariantResponse).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts.local-variant-v2.txt")!;
        using var reader=new StreamReader(stream);return Prompt()+"\n"+reader.ReadToEnd();
    }
    public static string Prompt()
    {
        using var stream = typeof(VariantResponse).Assembly.GetManifestResourceStream("EduMaster.Core.Prompts.file-variant-v1.txt")!;
        using var reader = new StreamReader(stream); return reader.ReadToEnd();
    }
    public static SampleResult Parse(string text, ProblemDraft draft, string model, string usage, bool requireTextMatch = false)
    {
        try
        {
            using var document = JsonDocument.Parse(text); var v = document.RootElement;
            if (v.GetProperty("status").GetString() == "unsupported") throw new UnsupportedProblemException("자료에서 문제를 만들지 못했습니다 · " + Required(v, "message", 1000));
            if (v.GetProperty("status").GetString() != "ready") throw new InvalidDataException("AI 문항 응답 상태가 올바르지 않습니다.");
            var source = Required(v, "sourceProblem", 12000); var body = Required(v, "body", 12000);
            var compact = static (string s) => string.Concat(s.Where(c => !char.IsWhiteSpace(c)));
            if (compact(source) == compact(body)) throw new InvalidDataException("원문이 그대로 반환되었습니다. 변형 문제를 다시 생성해 주세요.");
            if ((requireTextMatch || draft.Source?.IsAttachment != true) && !compact(draft.Body).Contains(compact(source), StringComparison.Ordinal))
                throw new InvalidDataException("AI가 읽은 기준 문제가 입력 본문과 맞지 않습니다. 본문을 확인한 뒤 다시 생성해 주세요.");
            var choices = v.GetProperty("choices").EnumerateArray().Select(c => c.GetString()?.Trim() ?? "").ToArray();
            var steps = v.GetProperty("steps").EnumerateArray().Select(c => c.GetString()?.Trim() ?? "").ToArray();
            var answer = v.GetProperty("answerIndex").GetInt32();
            var expectedSteps=draft.UseSolutionLogic?draft.Steps.Length:(int?)null;
            if (choices.Length != 5 || choices.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 3000) || choices.Select(compact).Distinct().Count() != 5 ||
                answer is < 0 or > 4 || steps.Length is < ProblemDraft.MinLogicSteps or > ProblemDraft.MaxLogicSteps || expectedSteps is not null&&steps.Length!=expectedSteps || steps.Any(s => string.IsNullOrWhiteSpace(s) || s.Length > 3000))
                throw new InvalidDataException("보기·정답·풀이 단계 형식이 올바르지 않습니다. 결과를 다시 생성해 주세요.");
            var explanation=WithStepHeadings(Required(v,"explanation",12000),steps);
            return new(Guid.NewGuid(), draft.Id, draft.Fingerprint(), Required(v,"title",200), body, choices,
                new[] {"①","②","③","④","⑤"}[answer] + " " + choices[answer], explanation, steps, Required(v,"changeSummary",3000))
            { GenerationNotice = "AI 초안 · 독립 검산·교사 확인 전", SourceProblem = Required(v,"sourceLocation",200) + "\n" + source,
                Model = model, PromptVersion = PromptVersion, UsageSummary = usage };
        }
        catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        { throw new InvalidDataException("AI 응답을 읽지 못했습니다. 누락·잘린 응답은 결과로 사용하지 않습니다.",e); }
    }
    private static string Required(JsonElement v,string name,int limit)
    { var s=v.GetProperty(name).GetString(); return !string.IsNullOrWhiteSpace(s)&&s.Length<=limit?s.Trim():throw new InvalidDataException("응답 필드가 비었거나 너무 깁니다: "+name); }
    public static string WithStepHeadings(string explanation,IReadOnlyList<string> steps)
    {
        if(steps.Count==0||Enumerable.Range(1,steps.Count).All(number=>explanation.Contains($"STEP {number}",StringComparison.OrdinalIgnoreCase)))return explanation;
        var outline=string.Join("\n\n",steps.Select((step,index)=>$"STEP {index+1}. {(step.Length<=240?step:step[..240])}"));
        var structured=outline+"\n\n상세 해설\n"+explanation;
        return structured.Length<=12000?structured:explanation;
    }
    public static object LocalSchema(ProblemDraft draft,string? requiredVariantBody=null)
    {
        var properties=new Dictionary<string,object>{
            ["status"]=new{type="string",@enum=new[]{"ready","unsupported"}},
            ["message"]=new{type="string"},["title"]=new{type="string"},
            ["body"]=new{type="string"},["changeSummary"]=new{type="string"},
            ["choices"]=new{type="array",maxItems=5,items=new{type="string"}},
            ["answerText"]=new{type="string"},
            ["explanation"]=new{type="string"},
            ["steps"]=new{type="array",minItems=draft.UseSolutionLogic?draft.Steps.Length:ProblemDraft.MinLogicSteps,maxItems=draft.UseSolutionLogic?draft.Steps.Length:ProblemDraft.MaxLogicSteps,items=new{type="string"}},
            ["sourceLocation"]=new{type="string"},
            ["inputFingerprint"]=new{type="string",@enum=new[]{draft.Fingerprint()}}
        };
        properties["drawings"]=ScientificVisuals.DrawingSchema();
        properties["visualTemplates"]=ScientificTemplates.Schema();
        properties["visualRequirement"]=new{type="string",@enum=new[]{"none","required"}};
        if(requiredVariantBody is not null)properties["body"]=new{type="string",@enum=new[]{requiredVariantBody,""}};
        return new{type="object",properties,required=properties.Keys.ToArray()};
    }
    public static object Schema(string? exactSource = null,int? exactStepCount=null)
    {
        var properties=new Dictionary<string,object>();
        properties["status"]=new{type="string",@enum=new[]{"ready","unsupported"}};
        foreach(var name in new[]{"message","changeSummary","title","body"}) properties[name]=new{type="string"};
        properties["steps"]=new{type="array",items=new{type="string"},minItems=exactStepCount??ProblemDraft.MinLogicSteps,maxItems=exactStepCount??ProblemDraft.MaxLogicSteps};
        properties["explanation"]=new{type="string"};
        if(exactSource is not null) properties["answerText"]=new{type="string"};
        properties["choices"]=new{type="array",items=new{type="string"},maxItems=5};
        if(exactSource is null) properties["answerIndex"]=new{type="integer"};
        properties["sourceLocation"]=new{type="string"};
        properties["sourceProblem"]=new{type="string"};
        if(exactSource is not null) properties["sourceProblem"]=new{type="string",@enum=new[]{exactSource,""}};
        return new{type="object",properties,required=properties.Keys.ToArray()};
    }
}
