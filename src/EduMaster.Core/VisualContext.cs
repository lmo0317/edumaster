using System.Text.Json;
namespace EduMaster.Core;

public sealed record VisualPage(byte[] Bytes, string MimeType, int Page)
{
    public string MaterialRole {get;init;}="";
    public string DataUrl => $"data:{MimeType};base64,{Convert.ToBase64String(Bytes)}";
}
public sealed record VisualNode(string Id,string Label);
public sealed record VisualEdge(string From,string To,string Relation);
public sealed record VisualUnderstanding(string Kind,string Summary,VisualNode[] Nodes,VisualEdge[] Edges,string[] Constraints,string[] Uncertainties)
{
    public static VisualUnderstanding Parse(string json)
    {
        try
        {
            var v=JsonSerializer.Deserialize<VisualUnderstanding>(json,new JsonSerializerOptions{PropertyNameCaseInsensitive=true})??throw new InvalidDataException("시각 정보가 없습니다.");
            if(v.Kind is not("text" or "table" or "graph" or "molecule" or "diagram") || string.IsNullOrWhiteSpace(v.Summary) || v.Summary.Length>2000 || v.Nodes is null || v.Edges is null || v.Constraints is null || v.Uncertainties is null || v.Nodes.Length>100 || v.Edges.Length>150 || v.Constraints.Length>50 || v.Uncertainties.Length>30)
                throw new InvalidDataException("시각 정보 구조를 확인하지 못했습니다.");
            if(v.Nodes.Any(n=>n is null||string.IsNullOrWhiteSpace(n.Id)||string.IsNullOrWhiteSpace(n.Label)||n.Id.Length>100||n.Label.Length>500) || v.Nodes.Select(n=>n.Id).Distinct().Count()!=v.Nodes.Length || v.Edges.Any(e=>e is null||!v.Nodes.Any(n=>n.Id==e.From)||!v.Nodes.Any(n=>n.Id==e.To)||string.IsNullOrWhiteSpace(e.Relation)||e.Relation.Length>500) || v.Constraints.Concat(v.Uncertainties).Any(s=>string.IsNullOrWhiteSpace(s)||s.Length>1500))
                throw new InvalidDataException("그림의 연결 관계가 불완전합니다.");
            var fatalUncertainties = v.Uncertainties
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .Where(s => !s.Contains("충돌은 없음") && !s.Contains("충돌 없음") && !s.Contains("모순 없음"))
                .Where(s => !(v.Kind is "table" or "text" && (s.Contains("단서") || s.Contains("필기") || s.Contains("손글씨") || s.Contains("변수") || s.Contains("계수"))))
                .ToArray();
            if(fatalUncertainties.Length>0)throw new InvalidDataException("그림을 확실하게 판독하지 못해 생성을 중단했습니다: "+string.Join(" · ",fatalUncertainties));
            if(v.Kind is "graph" or "molecule" or "diagram" && (v.Nodes.Length==0||v.Edges.Length==0||v.Constraints.Length==0))throw new InvalidDataException("축·결합·연결 조건이 부족합니다. 더 선명한 그림으로 다시 넣어 주세요.");
            return v;
        }
        catch(JsonException e){throw new InvalidDataException("시각 정보 응답 형식이 잘못되었습니다.",e);}
    }
}
public sealed record PreservedFigure(int Page,string DataUrl,string Caption);
