{{- define "helpudoc.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" -}}
{{- else if contains $name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "helpudoc.labels" -}}
app.kubernetes.io/name: {{ default .Chart.Name .Values.nameOverride | quote }}
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "helpudoc.selector" -}}
app.kubernetes.io/instance: {{ .root.Release.Name | quote }}
app.kubernetes.io/part-of: {{ include "helpudoc.fullname" .root | quote }}
app.kubernetes.io/component: {{ .component | quote }}
{{- end -}}

{{- define "helpudoc.podLabels" -}}
{{ include "helpudoc.selector" . }}
{{- if .root.Values.ezua.enabled }}
hpe-ezua/app: {{ .root.Values.ezua.appName | quote }}
hpe-ezua/type: vendor-service
{{- end }}
{{- with .root.Values.podLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "helpudoc.image" -}}
{{- if .digest -}}
{{ .repository }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ required "Every image needs a tag or digest" .tag }}
{{- end -}}
{{- end -}}

{{- define "helpudoc.claim" -}}
{{- $claim := index .root.Values.persistence.claims .name -}}
{{- default (printf "%s-%s" (include "helpudoc.fullname" .root) .name) $claim.existingClaim -}}
{{- end -}}

{{- define "helpudoc.s3Endpoint" -}}
{{- if .Values.objectStore.enabled -}}
http://{{ include "helpudoc.fullname" . }}-objects:9000
{{- else -}}
{{ required "objectStore.externalEndpoint is required for external storage" .Values.objectStore.externalEndpoint }}
{{- end -}}
{{- end -}}

{{- define "helpudoc.scheduling" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.nodeSelector }}
nodeSelector:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.tolerations }}
tolerations:
{{ toYaml . | indent 2 }}
{{- end }}
{{- with .Values.affinity }}
affinity:
{{ toYaml . | indent 2 }}
{{- end }}
{{- end -}}

{{- define "helpudoc.envFrom" -}}
- configMapRef:
    name: {{ include "helpudoc.fullname" . }}-env
- secretRef:
    name: {{ required "existingSecret is required" .Values.existingSecret }}
{{- end -}}

{{- define "helpudoc.appEnv" -}}
- name: NODE_ENV
  value: production
- name: WORKSPACE_ROOT
  value: /app/workspaces
- name: SKILLS_ROOT
  value: /app/skills
- name: PLUGINS_ROOT
  value: /app/plugins
- name: AGENT_CONFIG_PATH
  value: /agent/config/runtime.yaml
- name: AGENT_STORE_DATABASE_URL
  value: "$(DATABASE_URL)"
{{- end -}}
